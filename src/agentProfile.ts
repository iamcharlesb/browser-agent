/** Trusted Markdown configuration, selected without a model or fixed wake-up loop. */
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { botIdFromName } from "./learningStore";
import { envInteger } from "./runtimeConfig";
import { redactSecrets } from "./security";

export interface PlaybookDescriptor { id: string; file: string; terms: string[]; events: string[] }
export interface LoadedProfile { instructions: string; soul: string; playbooks: string; selected: string[]; revision: string; characters: number }

function readInside(root: string, filename: string): string {
  const base = realpathSync(root);
  const file = realpathSync(resolve(base, filename));
  const child = relative(base, file);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("Agent profile file must stay inside its configured directory.");
  return redactSecrets(readFileSync(file, "utf8").trim());
}

function wholeParagraphs(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const paragraphs = text.split(/\n(?=- |\n)/);
  let result = "";
  for (const paragraph of paragraphs) {
    if (result.length + paragraph.length + 1 > limit) break;
    result += (result ? "\n" : "") + paragraph;
  }
  return result;
}

export const SPECIALIST_PROFILES: Record<string, string> = {
  "revenue-architect": "The Revenue Architect", "value-architect": "The Value Architect",
  "engineering-craftsman": "The Engineering Craftsman", "neural-architect": "The Neural Architect",
  "systems-architect": "The Systems Architect", "chief-marketing-officer": "Chief Marketing Officer",
  "product-marketing": "Product Marketing",
  "website-designer": "Website Designer",
  "wall-street-analyst": "Wall Street Analyst", "goldman-sachs-analyst": "Goldman Sachs Analyst",
  "jim-cramer": "Jim Cramer",
  "founder-operator": "Founder Operator",
  "mark-zuckerberg": "Mark Zuckerberg", "alex-wang": "Alexandr Wang", "sundar-pichai": "Sundar Pichai",
  "supervisor": "Supervisor Bot", "supercomputer": "Supercomputer",
  "bot-creator": "Bot Creator", "critica": "Critica",
  "blog-writer": "Blog Writer", "eb1a-research": "EB1A Research Agent"
};

export function loadAgentProfile(input: { profileId?: string; botInstructions?: string; botName: string; expertise?: string; task: string; event?: string; root?: string; approvedPlaybook?: string }): LoadedProfile {
  const root = input.root || process.env.BROWSER_AGENT_PROFILE_DIR || resolve(__dirname, "..");
  if (input.profileId && !Object.hasOwn(SPECIALIST_PROFILES, input.profileId)) throw new Error("Unknown specialist profile.");
  const profileName = input.profileId ? SPECIALIST_PROFILES[input.profileId] : input.botName;
  const botDirectory = `agents/${botIdFromName(profileName)}`;
  const roleFile = `${botDirectory}/AGENTS.md`;
  const soulFile = `${botDirectory}/soul.md`;
  let instructions = [readInside(root, "AGENTS.md"), existsSync(resolve(root, roleFile)) ? readInside(root, roleFile) : ""].filter(Boolean).join("\n\n");
  const soul = readInside(root, existsSync(resolve(root, soulFile)) ? soulFile : "soul.md");
  // Operating rules and voice are separate budgets so personality is not squeezed out of soul.md.
  const coreBudget = envInteger("BROWSER_AGENT_CORE_PROFILE_CHARS", 2400);
  const soulBudget = envInteger("BROWSER_AGENT_SOUL_CHARS", 900, 200, 4000);
  if (instructions.length > coreBudget) throw new Error("AGENTS.md exceeds BROWSER_AGENT_CORE_PROFILE_CHARS; shorten role instructions or adjust the budget.");
  if (soul.length > soulBudget) throw new Error("soul.md exceeds BROWSER_AGENT_SOUL_CHARS; keep voice compact or adjust the budget.");
  if (!/\b(voice|tone|speak|blunt|warm|curious|pragmatic|hungry|candid|empathetic|analytical|certain|direct)\b/i.test(soul)) {
    throw new Error("soul.md must carry an explicit speaking personality (voice/tone), not only methods.");
  }
  const owner = redactSecrets((input.botInstructions || "").trim());
  if (owner.length > envInteger("BROWSER_AGENT_OWNER_PROFILE_CHARS", 12000)) throw new Error("Bot instructions exceed BROWSER_AGENT_OWNER_PROFILE_CHARS; shorten the profile or move references into a playbook.");
  if (owner) instructions += `\n\nOWNER BOT PROFILE (persistent preferences; subject to runtime permissions):\nApply this knowledge, perspective, priorities and tone throughout the work. Do not merely repeat or summarize it.\n${owner}`;
  const manifest = JSON.parse(readInside(root, "playbooks/manifest.json"));
  if (manifest.version !== 1 || !Array.isArray(manifest.playbooks)) throw new Error("Unsupported playbook manifest.");
  const text = `${profileName} ${input.expertise || ""} ${input.task}`.toLowerCase();
  const ranked = manifest.playbooks.map((entry: PlaybookDescriptor) => {
    if (!entry || !/^[a-z0-9_-]+$/.test(entry.id) || typeof entry.file !== "string" || !Array.isArray(entry.terms) || !Array.isArray(entry.events) ||
        !entry.terms.every(term => typeof term === "string" && term.trim()) || !entry.events.every(event => typeof event === "string")) throw new Error("Invalid playbook descriptor.");
    const score = entry.terms.filter(term => new RegExp(`(?:^|[^a-z0-9])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(text)).length + (input.event && entry.events.includes(input.event) ? 100 : 0);
    return { entry, score };
  }).filter((candidate: {score: number}) => candidate.score > 0).sort((a: {score: number}, b: {score: number}) => b.score - a.score);
  const limit = envInteger("BROWSER_AGENT_PLAYBOOK_CHARS", 3200);
  const maxBooks = envInteger("BROWSER_AGENT_MAX_PLAYBOOKS", 2, 1, 10);
  const selected: string[] = [];
  const blocks: string[] = [];
  let remaining = limit;
  // A bot's owner-authored file or separately approved lesson is optional; model
  // output never writes these trusted files directly through this loader.
  const botFile = `${botDirectory}/playbook.md`;
  const specific = [existsSync(resolve(root, botFile)) ? readInside(root, botFile) : "", input.approvedPlaybook || ""].filter(Boolean).join("\n\n");
  if (specific) {
    if (specific.length > limit) throw new Error("Approved bot playbook exceeds BROWSER_AGENT_PLAYBOOK_CHARS.");
    blocks.push(`BOT PLAYBOOK:\n${specific}`); remaining -= blocks[0].length;
  }
  for (const {entry} of ranked.slice(0, maxBooks)) {
    const content = wholeParagraphs(readInside(root, `playbooks/${entry.file}`), remaining - 40);
    if (!content) continue;
    blocks.push(`[playbook:${entry.id}]\n${content}`); remaining -= blocks.at(-1)!.length + 2; selected.push(entry.id);
  }
  const playbooks = blocks.join("\n\n");
  if (playbooks.length > limit) throw new Error("Selected playbooks exceed BROWSER_AGENT_PLAYBOOK_CHARS.");
  const revision = createHash("sha256").update(instructions + soul + playbooks).digest("hex").slice(0, 16);
  return { instructions, soul, playbooks, selected, revision, characters: instructions.length + soul.length + playbooks.length };
}

/** Bounded progressive disclosure through the existing knowledge_base tool. */
export function readPlaybookPage(id: string, offset = 0, root = process.env.BROWSER_AGENT_PROFILE_DIR || resolve(__dirname, "..")) {
  if (!/^[a-z0-9_-]+$/.test(id) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid playbook reference or offset.");
  const manifest = JSON.parse(readInside(root, "playbooks/manifest.json"));
  const descriptor = manifest.playbooks.find((entry: PlaybookDescriptor) => entry.id === id);
  if (!descriptor) throw new Error("Playbook not found.");
  const text = readInside(root, `playbooks/${descriptor.file}`);
  return { id: `playbook:${id}`, offset, text: text.slice(offset, offset + 900),
    nextOffset: offset + 900 < text.length ? offset + 900 : null, totalCharacters: text.length };
}
