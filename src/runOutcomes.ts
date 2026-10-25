/** The bus carries references; full results stay in durable, private task storage. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecretValues } from "./security";
import type { AgentResult } from "./promptLoop";

export interface RunOutcome { id: string; botName: string; result: AgentResult; createdAt: string }
export async function storeRunOutcome(directory: string, botName: string, result: AgentResult): Promise<RunOutcome> {
  const record = redactSecretValues({ id: `outcome_${randomUUID()}`, botName, result, createdAt: new Date().toISOString() });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${record.id}.json`), temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, target);
  return record;
}
export async function readRunOutcome(directory: string, id: string): Promise<RunOutcome> {
  if (!/^outcome_[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid outcome reference.");
  return JSON.parse(await readFile(join(directory, `${id}.json`), "utf8"));
}
export function outcomeEvent(record: RunOutcome) {
  return { event: record.result.success ? "task.completed" : "task.failed", taskId: record.id,
    botName: record.botName, status: record.result.success ? "completed" : "failed", ref: record.id };
}
