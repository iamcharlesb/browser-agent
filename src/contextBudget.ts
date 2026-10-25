/** Bound text context by removing complete old observation/action/result rounds. */
export interface ContextMessage { role?: string; content?: unknown; [key: string]: unknown }
export class ContextBudgetExceeded extends Error {}

export function contextCharacters(messages: ContextMessage[]): number {
  return JSON.stringify(messages, (_key, value) =>
    typeof value === "string" && value.startsWith("data:image/") ? "[image budgeted separately]" : value
  ).length;
}

export function compactContext(messages: ContextMessage[], maxCharacters: number, keepRecentTurns = 2): { removedMessages: number; before: number; after: number } {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || !Number.isSafeInteger(keepRecentTurns) || keepRecentTurns < 1) {
    throw new Error("Context budget and recent-turn count must be positive integers.");
  }
  const before = contextCharacters(messages);
  if (before <= maxCharacters) return { removedMessages: 0, before, after: before };
  const firstUser = messages.findIndex(message => message.role === "user");
  const start = firstUser < 0 ? 0 : firstUser + 1;
  const boundaries = [start];
  for (let i = start; i < messages.length; i++) if (messages[i].role === "user" && i !== start) boundaries.push(i);
  boundaries.push(messages.length);
  const removable: number[] = [];
  let after = before;
  for (let round = 0; round < boundaries.length - 1 - keepRecentTurns && after > maxCharacters; round++) {
    for (let i = boundaries[round]; i < boundaries[round + 1]; i++) {
      if (messages[i].role !== "system") removable.push(i);
    }
    const removed = new Set(removable);
    after = contextCharacters(messages.filter((_message, index) => !removed.has(index)));
  }
  if (after > maxCharacters) {
    throw new ContextBudgetExceeded("The task, system instructions and recent observations exceed BROWSER_AGENT_CONTEXT_CHARS. Narrow the input or raise the configured budget.");
  }
  for (const index of removable.reverse()) messages.splice(index, 1);
  return { removedMessages: removable.length, before, after };
}
