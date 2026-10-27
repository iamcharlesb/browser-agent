/** Terminal transport uses the same queue, policies and scoped approvals as the UI. */
export type TerminalEvent = Record<string, any>;
export interface TerminalRun {
  task: string;
  botName: string;
  profileId?: string;
  model?: string;
  interactionMode: "chat" | "browse" | "act";
  agentEngine: "cheap" | "openai-sdk";
}
export class ApiError extends Error {
  constructor(readonly status: number, readonly detail: string, readonly body: TerminalEvent) {
    super(detail);
  }
}

export function localServerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--server must be a local HTTP origin, for example http://127.0.0.1:8765.");
  }
  return url.origin;
}

export class TerminalClient {
  readonly base: string;
  constructor(base: string) { this.base = localServerUrl(base); }

  async json(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<TerminalEvent> {
    const response = await fetch(this.base + path, {
      method, headers: { origin: this.base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
    });
    const result = await response.json() as TerminalEvent;
    if (!response.ok) throw new ApiError(response.status, result.detail || `HTTP ${response.status}`, result);
    return result;
  }

  private async events(runId: string, onEvent: (event: TerminalEvent) => Promise<void>, signal: AbortSignal): Promise<TerminalEvent> {
    const response = await fetch(this.base + "/api/events?runId=" + encodeURIComponent(runId), { signal });
    if (!response.ok || !response.body) throw new Error(`Run stream unavailable (HTTP ${response.status}).`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          const event = JSON.parse(data) as TerminalEvent;
          await onEvent(event);
          if (event.type === "terminal") return event;
        }
        if (chunk.done) throw new Error("Run stream closed without a terminal result. The request was not retried.");
      }
    } finally { await reader.cancel().catch(() => undefined); }
  }

  async run(input: TerminalRun, options: {
    signal: AbortSignal;
    onEvent?: (event: TerminalEvent) => Promise<void>;
    approve?: (description: string) => Promise<boolean>;
  }): Promise<TerminalEvent> {
    let jobId: string | undefined, activeRunId: string | undefined, activeDiscussionId: string | undefined;
    const approvedCategories: string[] = [];
    const pause = () => new Promise<void>((done, reject) => {
      options.signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
      const timer = setTimeout(() => { options.signal.removeEventListener("abort", abort); done(); }, 100);
      options.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      let submitted: TerminalEvent;
      try { submitted = await this.json("/api/run/queue", "POST", input, options.signal); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 428 || !options.approve ||
            !await options.approve(error.detail)) throw error;
        approvedCategories.push(...error.body.approvalsRequired);
        submitted = await this.json("/api/run/queue", "POST", { ...input, approvedCategories }, options.signal);
      }
      jobId = submitted.id;
      while (!activeRunId) {
        const job = await this.json("/api/run/jobs/" + encodeURIComponent(jobId!), "GET", undefined, options.signal);
        if (job.runId) activeRunId = job.runId;
        else if (["failed", "cancelled", "completed"].includes(job.status)) throw new Error(job.detail || `Request ${job.status} without an available result.`);
        else await pause();
      }
      const seen = new Set<string>();
      while (true) {
        const runId = activeRunId!;
        seen.add(runId);
        const terminal = await this.events(runId, async event => {
          if (typeof event.discussionId === "string") activeDiscussionId = event.discussionId;
          if (event.type === "privileged_approval_required") {
            const approved = options.approve ? await options.approve(String(event.description || event.message)) : false;
            await this.json("/api/approval", "POST", { approvalId: event.approvalId, approved, scope: "once" }, options.signal);
          }
          if (event.type === "human_verification") throw new Error("Human verification is waiting in the browser. Complete it through the local UI; this CLI request is being stopped.");
          await options.onEvent?.(event);
        }, options.signal);
        if (!terminal.discussionId || terminal.discussionFinal) return terminal;
        while (true) {
          const discussion = await this.json("/api/discussions/" + encodeURIComponent(terminal.discussionId), "GET", undefined, options.signal);
          if (discussion.runId && !seen.has(discussion.runId)) { activeRunId = discussion.runId; break; }
          if (["completed", "failed", "cancelled"].includes(discussion.phase)) {
            if (terminal.delegateTo) throw new Error(`Discussion ${discussion.phase} without a final answer.`);
            return terminal;
          }
          await pause();
        }
      }
    } catch (error) {
      // Cancel only this client's job/discussion. Never replay an uncertain outward action.
      if (activeDiscussionId) await this.json("/api/stop?discussionId=" + encodeURIComponent(activeDiscussionId), "POST").catch(() => undefined);
      else if (activeRunId) await this.json("/api/stop?runId=" + encodeURIComponent(activeRunId), "POST").catch(() => undefined);
      if (jobId) await this.json("/api/run/jobs/" + encodeURIComponent(jobId), "DELETE").catch(() => undefined);
      throw error;
    }
  }
}
