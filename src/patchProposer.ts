import { redactSecrets } from "./security";
import { defaultModel, resolveModel } from "./runtimeConfig";
/**
 * Turns learn mode's improvement notes into exact-text source patches.
 *
 * This is the only part of the self-fix path that needs a model, and it is deliberately the part
 * with no authority: it returns *proposals*. selfFix validates every one of them, applies all or
 * none, and rolls the tree back unless the real build and test suite go green. When no model
 * backend is available this returns undefined and learn mode reports the findings without touching
 * the source, which is the honest outcome rather than a guessed edit.
 */

import { readFile } from "node:fs/promises";
import OpenAI from "openai";

import { ImprovementNote, LearnTurn } from "./learnMode";
import { ProposedPatch } from "./selfFix";
import { isClaudeCliAvailable, claudeCliModelAlias, invokeClaudeCli, isClaudeCliModel } from "./claudeCli";
import { resolvePatchTarget } from "./selfFix";

/** Characters of each referenced file handed to the model, centred on the hinted symbol. */
const FILE_EXCERPT_CHARS = 14_000;
const FILE_PATH_PATTERN = /\b(?:src|static)\/[A-Za-z0-9_\-./]+\.(?:ts|html|css|md)\b/g;

export interface PatchProposerOptions {
  repoRoot: string;
  /** Same model string the UI uses; "claude-cli*" routes through the local CLI login. */
  model?: string;
  apiKey?: string;
  maxPatches?: number;
  /** Injectable for tests: given the prompt, return the model's raw text. */
  complete?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
}

export function extractReferencedFiles(notes: ImprovementNote[]): string[] {
  const files = new Set<string>();
  for (const note of notes) {
    for (const match of `${note.area} ${note.suggestedFix}`.matchAll(FILE_PATH_PATTERN)) {
      files.add(match[0]);
    }
  }
  return [...files];
}

/** The hint in `src/promptLoop.ts (humanizeSummary)` tells us which part of a big file to show. */
function hintFor(notes: ImprovementNote[], file: string): string | null {
  for (const note of notes) {
    const match = note.area.match(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(([^)]+)\\)`));
    if (match) return match[1].split(/[,+]/)[0].trim();
  }
  return null;
}

async function excerptFor(repoRoot: string, file: string, hint: string | null): Promise<string | null> {
  const target = resolvePatchTarget(repoRoot, file);
  if (!target.ok) return null;
  let content: string;
  try {
    content = await readFile(target.absolutePath, "utf8");
  } catch {
    return null;
  }
  if (content.length <= FILE_EXCERPT_CHARS) return content;

  const anchor = hint ? content.indexOf(hint) : -1;
  if (anchor === -1) return `${content.slice(0, FILE_EXCERPT_CHARS)}\n/* ...truncated... */`;
  const start = Math.max(0, anchor - Math.floor(FILE_EXCERPT_CHARS / 2));
  const end = Math.min(content.length, start + FILE_EXCERPT_CHARS);
  return `${start > 0 ? "/* ...truncated above... */\n" : ""}${content.slice(start, end)}${
    end < content.length ? "\n/* ...truncated below... */" : ""
  }`;
}

const SYSTEM_PROMPT = [
  "You repair your own source code after a self-review found a weak spot in the user experience.",
  "Return JSON only, shaped exactly: {\"patches\":[{\"file\":\"src/x.ts\",\"find\":\"...\",\"replace\":\"...\",\"rationale\":\"...\"}]}",
  "Hard rules:",
  "- `find` must be text copied verbatim from the file shown to you and must occur EXACTLY ONCE in it.",
  "- Keep each edit surgical: the smallest change that fixes the finding. Never reformat or move code.",
  "- TypeScript must still compile and the existing test suite must still pass. No new dependencies.",
  "- Never touch credentials, approval gates, risk checks, or the privileged-tool allowlist to make something easier.",
  "- Only files shown to you, only repo-relative paths under src/ or static/.",
  "- If you cannot write a safe, certain patch for a finding, leave it out. An empty patches array is a valid answer.",
  "- No prose outside the JSON object."
].join("\n");

function buildUserPrompt(input: {
  notes: ImprovementNote[];
  transcript: LearnTurn[];
  task: string;
  files: Array<{ file: string; excerpt: string }>;
  maxPatches: number;
}): string {
  const lines: string[] = [];
  lines.push(`The user's task was: ${input.task}`);
  lines.push("");
  lines.push("Self-play transcript (what the user experienced):");
  for (const turn of input.transcript) {
    lines.push(
      `- round ${turn.round}: user said "${turn.userMessage.slice(0, 200)}" -> ${
        turn.success ? "ok" : "FAILED"
      } after ${turn.stepsTaken} step(s) (${turn.terminationReason}), ${turn.failedToolCalls}/${turn.toolCalls} tool calls failed. Reply: "${turn.botSummary.slice(0, 300)}"`
    );
  }
  lines.push("");
  lines.push(`Findings to fix (at most ${input.maxPatches} patches):`);
  for (const note of input.notes) {
    lines.push(`- [${note.severity}] ${note.dimension} in ${note.area}: ${note.evidence} Suggested: ${note.suggestedFix}`);
  }
  lines.push("");
  for (const file of input.files) {
    lines.push(`--- FILE ${file.file} ---`);
    lines.push(file.excerpt);
    lines.push(`--- END ${file.file} ---`);
  }
  return lines.join("\n");
}

export function parsePatchResponse(raw: string, maxPatches: number): ProposedPatch[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  const patches = (parsed as { patches?: unknown }).patches;
  if (!Array.isArray(patches)) return [];
  const result: ProposedPatch[] = [];
  for (const candidate of patches) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.file !== "string" ||
      typeof record.find !== "string" ||
      typeof record.replace !== "string" ||
      !record.find
    ) {
      continue;
    }
    result.push({
      file: record.file,
      find: record.find,
      replace: record.replace,
      rationale: typeof record.rationale === "string" ? record.rationale : "no rationale given"
    });
    if (result.length >= maxPatches) break;
  }
  return result;
}

function defaultComplete(options: PatchProposerOptions): ((input: { systemPrompt: string; userPrompt: string }) => Promise<string>) | null {
  const model = (options.model || process.env.BROWSER_AGENT_PATCH_MODEL || defaultModel()).trim();
  const provider = resolveModel(model).provider;
  const apiKey = options.apiKey ?? (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : provider === "xai" ? process.env.XAI_API_KEY : provider === "openai" ? process.env.OPENAI_API_KEY : undefined);

  if (isClaudeCliModel(model) && isClaudeCliAvailable()) {
    const alias = claudeCliModelAlias(model);
    return async ({ systemPrompt, userPrompt }) => {
      const result = await invokeClaudeCli({
        systemPrompt,
        userPrompt,
        ...(alias ? { modelAlias: alias } : {}),
        timeoutMs: 180_000,
        cwd: options.repoRoot
      });
      return result.structured.content ?? result.rawResultText;
    };
  }

  // The local heuristic engine cannot write a patch, so there is nothing to fall back to.
  if (!apiKey || model === "local-engine") return null;

  const isClaudeApi = provider === "anthropic";
  const client = new OpenAI({
    apiKey,
    ...(isClaudeApi
      ? {
          baseURL: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1/",
          defaultHeaders: { "anthropic-version": "2023-06-01" }
        }
      : provider === "xai"
        ? { baseURL: process.env.XAI_BASE_URL || "https://api.x.ai/v1" }
        : process.env.OPENAI_BASE_URL
        ? { baseURL: process.env.OPENAI_BASE_URL }
        : {})
  });

  return async ({ systemPrompt, userPrompt }) => {
    const resolvedModel = model;
    if (resolveModel(model).api === "responses" && provider === "openai") {
      const response = await client.responses.create({
        model, instructions: redactSecrets(systemPrompt), input: redactSecrets(userPrompt),
        max_output_tokens: 4000, store: false
      });
      return response.output_text ?? "";
    }
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: redactSecrets(systemPrompt) },
      { role: "user", content: redactSecrets(userPrompt) }
    ];
    try {
      const response = await client.chat.completions.create({
        model: resolvedModel,
        ...(isClaudeApi ? { max_tokens: 4_000 } : { max_completion_tokens: 4_000 }),
        messages
      });
      return response.choices[0]?.message?.content ?? "";
    } catch (err) {
      // Fallback if an older OpenAI-compatible endpoint only accepts max_tokens.
      if (!isClaudeApi && /max_completion_tokens/i.test((err as Error)?.message ?? "")) {
        const fallbackResponse = await client.chat.completions.create({
          model: resolvedModel,
          max_tokens: 4_000,
          messages
        });
        return fallbackResponse.choices[0]?.message?.content ?? "";
      }
      throw err;
    }
  };
}

/**
 * Returns a proposer for learn mode, or undefined when no model backend can write patches.
 * Undefined is a feature: learn mode then reports the areas and leaves the source alone.
 */
export function createPatchProposer(
  options: PatchProposerOptions
): ((input: { notes: ImprovementNote[]; transcript: LearnTurn[]; task: string }) => Promise<ProposedPatch[]>) | undefined {
  const complete = options.complete ?? defaultComplete(options);
  if (!complete) return undefined;
  const maxPatches = options.maxPatches ?? 4;

  return async ({ notes, transcript, task }) => {
    if (notes.length === 0) return [];
    const referenced = extractReferencedFiles(notes);
    const files: Array<{ file: string; excerpt: string }> = [];
    for (const file of referenced) {
      const excerpt = await excerptFor(options.repoRoot, file, hintFor(notes, file));
      if (excerpt) files.push({ file, excerpt });
    }
    if (files.length === 0) return [];

    const raw = await complete({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt({ notes, transcript, task, files, maxPatches })
    });
    // Anything the model returns for a file it was not shown is dropped here; selfFix would
    // reject it anyway, but there is no reason to carry it that far.
    const allowed = new Set(files.map((file) => file.file));
    return parsePatchResponse(raw, maxPatches).filter((patch) => allowed.has(patch.file));
  };
}
