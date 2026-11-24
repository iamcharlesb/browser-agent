/**
 * Deterministic, zero-token /help catalog for Pilo.
 * Served via GET /api/help and triggered locally by `/help [topic]` without invoking any model.
 */

export interface HelpItem {
  id: string;
  title: string;
  summary: string;
  command: string;
  steps?: string[];
  snippet?: string;
}

const HELP_ITEMS: HelpItem[] = [
  {
    id: "demos",
    title: "Demo Director Skill",
    summary: "Record actual screen demos with source preview, narration, timed capture, playback and video download.",
    command: "/help demos",
    steps: [
      "Choose Demo Director from the bot catalog for a dedicated conversation.",
      "Or type @Demo Director and select it in another bot's composer; send a message to request a consultation.",
      "Type /record 10 or click Record screen beside the microphone to open the real recorder without a model call.",
      "Preview the source, click Start recording, use the guided local walkthrough or perform your workflow, then play or download the WebM video. Nothing is published."
    ]
  },
  {
    id: "setup",
    title: "Quick Setup",
    summary: "Clone with submodules, install Node.js dependencies, and launch the desktop app.",
    command: "/help setup",
    steps: [
      "Clone recursively: git clone --recurse-submodules https://github.com/iamcharlesb/pilo.git",
      "Install dependencies: npm ci && npm --prefix node/browser_agent ci",
      "Install Chromium once: npm --prefix node/browser_agent exec playwright install chromium",
      "Launch Pilo: npm run desktop (opens http://127.0.0.1:8766)"
    ]
  },
  {
    id: "env",
    title: "Environment Settings (.env)",
    summary: "All provider keys, model IDs, endpoints, and runtime limits live in gitignored .env files.",
    command: "/help env",
    steps: [
      "Copy node/browser_agent/.env.example -> node/browser_agent/.env for the Pilo app.",
      "Set BROWSER_AGENT_PROVIDER to openai, qwen, kimi, anthropic, xai, ollama, or compatible.",
      "Fill only the API key for your chosen provider (or none for local Ollama).",
      "Root .env configures pilo-runtime & Agent Gateway (OLLAMA_BASE_URL=http://localhost:11434 without /v1)."
    ],
    snippet: [
      "# node/browser_agent/.env (cloud example)",
      "BROWSER_AGENT_PROVIDER=openai",
      "BROWSER_AGENT_MODEL=",
      "OPENAI_API_KEY=your_key_here",
      "BROWSER_AGENT_MAX_STEPS=25",
      "BROWSER_AGENT_MAX_DURATION_SECONDS=900"
    ].join("\n")
  },
  {
    id: "ollama",
    title: "Local Ollama Setup",
    summary: "Run local LLMs and tool-calling coding agents with zero cloud API keys.",
    command: "/help ollama",
    steps: [
      "Install Ollama and pull a tool-calling model: ollama pull qwen2.5-coder",
      "In Pilo Settings (gear icon) -> Connect a model provider -> Ollama (local), or set node/browser_agent/.env.",
      "Pilo uses http://127.0.0.1:11434/v1 (chat mode); pilo-runtime ChatOllama uses http://localhost:11434.",
      "For multi-file coding/patching, use a strong coder model such as qwen2.5-coder:32b."
    ],
    snippet: [
      "BROWSER_AGENT_PROVIDER=ollama",
      "BROWSER_AGENT_MODEL=",
      "OLLAMA_MODEL=qwen2.5-coder",
      "OLLAMA_BASE_URL=http://127.0.0.1:11434/v1",
      "OLLAMA_API_MODE=chat"
    ].join("\n")
  },
  {
    id: "gateway",
    title: "Agent Gateway (MCP, A2A, Failover)",
    summary: "Pure Node.js gateway unifying MCP tool federation, A2A Agent Cards, and multi-model routing.",
    command: "/help gateway",
    steps: [
      "MCP federation: POST /mcp aggregates namespaced tools/resources/prompts with RBAC filtering.",
      "A2A routing: /.well-known/agent.json, /a2a/agents, and /a2a/tasks with AbortSignal cancellation.",
      "Unified LLM routing: /v1/chat/completions and /v1/completions with automatic cloud-to-Ollama failover.",
      "Zero-trust controls: fail-closed JWT/API-key auth, guardrails, rate limits, and pre-call token budgets."
    ]
  },
  {
    id: "commands",
    title: "Slash Commands & Side-Pane Tools",
    summary: "Local commands and workspace utilities that open instantly without model charges.",
    command: "/help commands",
    steps: [
      "/help [topic] — Open Help index or jump to setup, env, ollama, gateway, or commands.",
      "/record 10 — Open the real screen recorder for a 10-second take; preview the source, then Start.",
      "Click + in the right pane — Open Workspace Launcher (Search or enter a URL).",
      "Review — Inspect staged, unstaged, and untracked Git changes.",
      "Open File — Browse and read workspace files safely inside the repo.",
      "Side Question — Ask a quick isolated question without interrupting the active bot.",
      "Plugins — View Agent Gateway protocols, configured providers, and built-in tools.",
      "/learn <task> — Rehearse a task and propose a reviewed playbook update (built mode)."
    ]
  }
];

export function getHelpCatalog(topic?: string): {
  topic: string | null;
  topics: Array<{ id: string; title: string; command: string }>;
  items: HelpItem[];
} {
  const normalized = topic?.trim().toLowerCase() || "";
  const matched = normalized
    ? HELP_ITEMS.filter(
        (item) =>
          item.id === normalized ||
          item.title.toLowerCase().includes(normalized) ||
          item.summary.toLowerCase().includes(normalized)
      )
    : HELP_ITEMS;

  return {
    topic: normalized || null,
    topics: HELP_ITEMS.map(({ id, title, command }) => ({ id, title, command })),
    items: matched.length > 0 ? matched : HELP_ITEMS
  };
}
