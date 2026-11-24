/** Explicit, local-operator conversation resets. Profiles and reviewed playbooks are separate. */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { botIdFromName, learningFilePath } from "./learningStore";

export interface ConversationResets { all: number; bots: Record<string, number> }
export async function readConversationResets(root: string): Promise<ConversationResets> {
  try {
    const value = JSON.parse(await readFile(join(root, ".browser-agent-conversation-resets.json"), "utf8"));
    return { all: Number(value.all) || 0, bots: value.bots || {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { all: 0, bots: {} };
    throw error;
  }
}
export function conversationEpoch(state: ConversationResets, botName: string): number {
  return Math.max(state.all, Number(state.bots[botIdFromName(botName)]) || 0);
}
export async function resetConversationFiles(root: string, scope: "bot" | "all", botName?: string): Promise<ConversationResets> {
  if (scope === "bot" && !botName?.trim()) throw new Error("Select a bot to reset.");
  const state = await readConversationResets(root);
  const stamp = Math.max(Date.now(), state.all + 1, ...Object.values(state.bots).map(value => value + 1));
  const botId = botName ? botIdFromName(botName) : undefined;
  for (const directory of [".browser-agent-task-memory", ".browser-agent-knowledge", ".browser-agent-learnings"]) {
    const base = join(root, directory);
    if (scope === "bot") {
      await unlink(learningFilePath(base, botId!)).catch(error => { if (error.code !== "ENOENT") throw error; });
    } else {
      const files = await readdir(base, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      for (const file of files) if (file.isFile() && /^[A-Za-z0-9_-]+\.json$/.test(file.name)) await unlink(join(base, file.name));
    }
  }
  const next = scope === "all" ? { all: stamp, bots: {} } : { all: state.all, bots: { ...state.bots, [botId!]: stamp } };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = join(root, ".browser-agent-conversation-resets.json"), temporary = file + ".tmp";
  await writeFile(temporary, JSON.stringify(next) + "\n", { mode: 0o600 });
  await rename(temporary, file);
  return next;
}
