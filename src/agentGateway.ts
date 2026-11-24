import { randomUUID, timingSafeEqual } from "node:crypto";
import { providerDefinition, providerKey, providerModel, providerURL, type CloudProvider } from "./providerRegistry";
import { redactSecrets } from "./security";

/**
 * Native Node.js Agent Gateway for Pilo.
 *
 * Unifies MCP tool federation, A2A agent discovery/routing, and multi-provider
 * LLM routing (including local Ollama failover) with zero-trust auth, RBAC,
 * guardrails, rate limiting, and redacted audit telemetry.
 */

export interface PiloGatewayActor {
  id: string;
  roles: string[];
}

export interface PiloGatewayRole {
  name: string;
  permissions: Array<{
    resourceType: "mcp_tool" | "a2a_agent" | "llm_provider" | "*";
    action: "call" | "invoke" | "*";
    resourceId?: string;
  }>;
}

export interface PiloGatewayTool {
  name: string;
  namespace?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, actor: PiloGatewayActor) => Promise<string> | string;
}

export interface PiloGatewayAgent {
  id: string;
  name: string;
  description: string;
  provider?: CloudProvider;
  model?: string;
  skills?: Array<{ id: string; name: string; description?: string }>;
  run: (input: string, context: { actor: PiloGatewayActor; traceId: string; sessionId?: string }) => Promise<string>;
}

export interface PiloGatewayTask {
  id: string;
  agentId: string;
  state: "working" | "completed" | "failed";
  input: string;
  output?: string;
  error?: string;
  traceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PiloGatewayAuditEntry {
  id: string;
  timestamp: string;
  traceId: string;
  actorId: string;
  protocol: "mcp" | "a2a" | "llm";
  resourceId: string;
  status: "ok" | "denied" | "rate_limited" | "error";
  message: string;
}

export interface PiloAgentGatewayConfig {
  name?: string;
  version?: string;
  apiKeys?: Array<{ id: string; key: string; roles: string[] }>;
  allowAnonymous?: boolean;
  roles?: PiloGatewayRole[];
  rateLimit?: { maxRequests: number; windowMs: number };
  blockedPatterns?: RegExp[];
  fetch?: typeof fetch;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function matches(pattern: string | undefined, value: string): boolean {
  return !pattern || pattern === "*" || pattern === value;
}

export class PiloAgentGateway {
  readonly name: string;
  readonly version: string;

  private apiKeys: Array<{ id: string; key: string; roles: string[] }>;
  private allowAnonymous: boolean;
  private roles = new Map<string, PiloGatewayRole>();
  private rateLimit?: { maxRequests: number; windowMs: number };
  private windows = new Map<string, number[]>();
  private blockedPatterns: RegExp[];
  private fetchImpl: typeof fetch;

  private tools = new Map<string, PiloGatewayTool>();
  private agents = new Map<string, PiloGatewayAgent>();
  private tasks = new Map<string, PiloGatewayTask>();
  private audit: PiloGatewayAuditEntry[] = [];
  private counters = { requests: 0, errors: 0, denied: 0, rateLimited: 0, totalTokens: 0 };

  constructor(config: PiloAgentGatewayConfig = {}) {
    this.name = config.name ?? "pilo-agent-gateway";
    this.version = config.version ?? "0.1.0";
    this.apiKeys = (config.apiKeys ?? []).filter((entry) => Boolean(entry.key));
    this.allowAnonymous = config.allowAnonymous ?? this.apiKeys.length === 0;
    for (const role of config.roles ?? []) {
      this.roles.set(role.name, role);
    }
    this.rateLimit = config.rateLimit;
    this.blockedPatterns = config.blockedPatterns ?? [];
    this.fetchImpl = config.fetch ?? fetch;
  }

  registerTool(tool: PiloGatewayTool): this {
    const exposedName = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
    this.tools.set(exposedName, { ...tool, name: exposedName });
    return this;
  }

  registerAgent(agent: PiloGatewayAgent): this {
    this.agents.set(agent.id, agent);
    return this;
  }

  private authenticate(headers: Record<string, string | string[] | undefined> = {}): PiloGatewayActor {
    const rawKey = headers["x-api-key"] ?? headers["X-API-Key"];
    const keyVal = (Array.isArray(rawKey) ? rawKey[0] : rawKey)?.trim();
    const rawAuth = headers["authorization"] ?? headers["Authorization"];
    const authVal = (Array.isArray(rawAuth) ? rawAuth[0] : rawAuth)?.trim();
    const candidate = keyVal || (authVal?.startsWith("Bearer ") ? authVal.slice(7).trim() : undefined);

    if (candidate) {
      for (const entry of this.apiKeys) {
        if (safeEqual(candidate, entry.key)) {
          return { id: entry.id, roles: [...entry.roles] };
        }
      }
      throw Object.assign(new Error("Invalid gateway API key."), { statusCode: 401 });
    }

    if (this.allowAnonymous) {
      return { id: "local-operator", roles: ["operator"] };
    }
    throw Object.assign(new Error("Authentication required."), { statusCode: 401 });
  }

  private isAuthorized(
    actor: PiloGatewayActor,
    resourceType: "mcp_tool" | "a2a_agent" | "llm_provider",
    action: "call" | "invoke",
    resourceId: string
  ): boolean {
    if (this.roles.size === 0) return true;
    for (const roleName of actor.roles) {
      const role = this.roles.get(roleName);
      if (!role) continue;
      if (
        role.permissions.some(
          (p) =>
            matches(p.resourceType, resourceType) &&
            matches(p.action, action) &&
            matches(p.resourceId, resourceId)
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private enforce(
    actor: PiloGatewayActor,
    protocol: "mcp" | "a2a" | "llm",
    resourceType: "mcp_tool" | "a2a_agent" | "llm_provider",
    action: "call" | "invoke",
    resourceId: string,
    payload: unknown,
    traceId: string
  ): void {
    this.counters.requests += 1;

    if (this.rateLimit) {
      const now = Date.now();
      const cutoff = now - this.rateLimit.windowMs;
      const hits = (this.windows.get(actor.id) ?? []).filter((ts) => ts > cutoff);
      if (hits.length >= this.rateLimit.maxRequests) {
        this.counters.rateLimited += 1;
        this.recordAudit(traceId, actor.id, protocol, resourceId, "rate_limited", "Rate limit exceeded.");
        throw Object.assign(new Error("Gateway rate limit exceeded."), { statusCode: 429 });
      }
      hits.push(now);
      this.windows.set(actor.id, hits);
    }

    if (!this.isAuthorized(actor, resourceType, action, resourceId)) {
      this.counters.denied += 1;
      this.recordAudit(traceId, actor.id, protocol, resourceId, "denied", `Forbidden: ${action} ${resourceType}:${resourceId}`);
      throw Object.assign(new Error(`Forbidden: cannot ${action} ${resourceType}:${resourceId}`), { statusCode: 403 });
    }

    const serialized = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
    for (const pattern of this.blockedPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(serialized)) {
        this.counters.denied += 1;
        this.recordAudit(traceId, actor.id, protocol, resourceId, "denied", "Blocked by gateway guardrail.");
        throw Object.assign(new Error("Blocked by gateway guardrail."), { statusCode: 403 });
      }
    }
  }

  private recordAudit(
    traceId: string,
    actorId: string,
    protocol: "mcp" | "a2a" | "llm",
    resourceId: string,
    status: PiloGatewayAuditEntry["status"],
    message: string
  ): void {
    this.audit.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      traceId,
      actorId,
      protocol,
      resourceId,
      status,
      message: redactSecrets(message)
    });
  }

  // ---- MCP Tool Gateway ----

  listTools(headers: Record<string, string | string[] | undefined> = {}) {
    const actor = this.authenticate(headers);
    return Array.from(this.tools.values())
      .filter((t) => this.isAuthorized(actor, "mcp_tool", "call", t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? { type: "object", properties: {} }
      }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined> = {}
  ): Promise<{ output: string; traceId: string }> {
    const traceId = randomUUID();
    const actor = this.authenticate(headers);
    const tool = this.tools.get(name);
    if (!tool) {
      throw Object.assign(new Error(`Unknown MCP tool "${name}".`), { statusCode: 404 });
    }
    this.enforce(actor, "mcp", "mcp_tool", "call", name, args, traceId);
    try {
      const output = redactSecrets(await tool.execute(args, actor));
      this.recordAudit(traceId, actor.id, "mcp", name, "ok", `Executed tool "${name}".`);
      return { output, traceId };
    } catch (error) {
      this.counters.errors += 1;
      const msg = error instanceof Error ? error.message : String(error);
      this.recordAudit(traceId, actor.id, "mcp", name, "error", msg);
      throw error;
    }
  }

  // ---- A2A Discovery & Task Routing ----

  getGatewayCard() {
    return {
      id: this.name,
      name: this.name,
      version: this.version,
      capabilities: { mcp: this.tools.size > 0, a2a: this.agents.size > 0 },
      skills: Array.from(this.agents.values()).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description
      }))
    };
  }

  listAgents(headers: Record<string, string | string[] | undefined> = {}) {
    const actor = this.authenticate(headers);
    return Array.from(this.agents.values())
      .filter((a) => this.isAuthorized(actor, "a2a_agent", "invoke", a.id))
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        provider: a.provider,
        model: a.model,
        skills: a.skills ?? []
      }));
  }

  async sendTask(
    request: { agentId: string; input: string; sessionId?: string },
    headers: Record<string, string | string[] | undefined> = {}
  ): Promise<PiloGatewayTask> {
    const traceId = randomUUID();
    const actor = this.authenticate(headers);
    const agent = this.agents.get(request.agentId);
    if (!agent) {
      throw Object.assign(new Error(`Unknown agent "${request.agentId}".`), { statusCode: 404 });
    }
    this.enforce(actor, "a2a", "a2a_agent", "invoke", request.agentId, request.input, traceId);

    const now = new Date().toISOString();
    const task: PiloGatewayTask = {
      id: randomUUID(),
      agentId: request.agentId,
      state: "working",
      input: request.input,
      traceId,
      createdAt: now,
      updatedAt: now
    };
    this.tasks.set(task.id, task);

    try {
      const output = redactSecrets(await agent.run(request.input, { actor, traceId, sessionId: request.sessionId }));
      task.state = "completed";
      task.output = output;
      task.updatedAt = new Date().toISOString();
      this.recordAudit(traceId, actor.id, "a2a", request.agentId, "ok", `Completed task ${task.id}.`);
      return task;
    } catch (error) {
      this.counters.errors += 1;
      task.state = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
      this.recordAudit(traceId, actor.id, "a2a", request.agentId, "error", task.error);
      throw error;
    }
  }

  // ---- Unified LLM Routing with Ollama Failover ----

  async routeChat(
    request: {
      provider: CloudProvider;
      model?: string;
      baseURL?: string;
      apiKey?: string;
      fallbackProviders?: Array<{ provider: CloudProvider; model?: string; baseURL?: string; apiKey?: string }>;
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    },
    headers: Record<string, string | string[] | undefined> = {}
  ): Promise<{
    provider: CloudProvider;
    model: string;
    content: string;
    fallbackUsed: boolean;
    totalTokens: number;
    traceId: string;
  }> {
    const traceId = randomUUID();
    const actor = this.authenticate(headers);
    const candidates = [
      { provider: request.provider, model: request.model, baseURL: request.baseURL, apiKey: request.apiKey },
      ...(request.fallbackProviders ?? [])
    ];

    let lastError: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      this.enforce(actor, "llm", "llm_provider", "invoke", candidate.provider, request.messages, traceId);

      const def = providerDefinition(candidate.provider);
      const model = candidate.model || (def ? providerModel(def) : undefined);
      const baseURL = (candidate.baseURL || (def ? providerURL(def) : undefined) || "").replace(/\/+$/, "");
      const apiKey = candidate.apiKey || (def ? providerKey(def) : undefined) || (candidate.provider === "ollama" ? "local-ollama" : "");

      if (!model || !baseURL) {
        lastError = new Error(`Provider "${candidate.provider}" is missing model or baseURL.`);
        continue;
      }

      try {
        const response = await this.fetchImpl(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...(def?.headers ?? {})
          },
          body: JSON.stringify({
            model,
            messages: request.messages
          })
        });

        if (!response.ok) {
          throw new Error(`Provider "${candidate.provider}" returned HTTP ${response.status}.`);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number };
        };
        const content = data.choices?.[0]?.message?.content ?? "";
        const totalTokens = data.usage?.total_tokens ?? 0;
        this.counters.totalTokens += totalTokens;
        this.recordAudit(traceId, actor.id, "llm", candidate.provider, "ok", `Routed chat to ${candidate.provider}/${model}.`);
        return {
          provider: candidate.provider,
          model,
          content,
          fallbackUsed: i > 0,
          totalTokens,
          traceId
        };
      } catch (error) {
        lastError = error;
        this.counters.errors += 1;
        this.recordAudit(
          traceId,
          actor.id,
          "llm",
          candidate.provider,
          "error",
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Discover models installed on a local Ollama instance via `/api/tags`. */
  async listOllamaModels(baseURL?: string): Promise<string[]> {
    const def = providerDefinition("ollama");
    const raw = (baseURL || (def ? providerURL(def) : undefined) || "http://127.0.0.1:11434")
      .replace(/\/v1\/?$/, "")
      .replace(/\/+$/, "");
    const response = await this.fetchImpl(`${raw}/api/tags`, { method: "GET" });
    if (!response.ok) throw new Error(`Ollama /api/tags failed with HTTP ${response.status}.`);
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
  }

  getMetrics() {
    return { ...this.counters, auditCount: this.audit.length };
  }

  getAuditLog(): PiloGatewayAuditEntry[] {
    return [...this.audit];
  }
}
