import type { WorkspaceBot } from "./botCoordination";

/** Explicit membership is validated before a job is queued or any model starts. */
export function parseHuddleParticipants(value: unknown, bots: WorkspaceBot[] | undefined, owner: string | undefined, maxParticipants: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 2 || value.length > maxParticipants) {
    throw new Error(`A huddle needs between 2 and ${maxParticipants} selected bots.`);
  }
  if (!value.every(id => typeof id === "string") || new Set(value).size !== value.length) throw new Error("Huddle participants must have distinct saved bot ids.");
  const members = value.map(id => bots?.find(bot => bot.id === id));
  if (members.some(bot => !bot || bot.name.toLowerCase() === owner?.trim().toLowerCase())) throw new Error("Every huddle participant must be an available saved bot, separate from the session.");
  if (new Set(members.map(bot => bot!.name.toLowerCase())).size !== members.length) throw new Error("Huddle participants need distinct names so replies can be attributed correctly.");
  return value as string[];
}
