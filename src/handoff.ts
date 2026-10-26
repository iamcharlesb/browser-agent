/**
 * The policy for one bot handing work to another.
 *
 * Kept separate from the server so it can be tested on its own, and so there is exactly one place
 * that decides whether a handoff may happen - the bus subscriber in server.ts is just the caller.
 */

import { AgentHandoffRequest } from "./messageBus";
import { assessTaskRisk } from "./security";

/** A -> B -> A would otherwise bounce between two bots forever. */
export const MAX_HANDOFF_DEPTH = 3;
const MAX_TASK_CHARS = 200_000;

export type HandoffDecision =
  | { allowed: true; delegatedTask: string }
  | { allowed: false; reason: string };

export function delegatedTaskFor(request: AgentHandoffRequest): string {
  return `Continue acting as ${request.toBot}. Task delegated by peer bot '${request.fromBot}': ${request.task}`.slice(
    0,
    MAX_TASK_CHARS
  );
}

export function decideHandoff(request: AgentHandoffRequest, maxDepth = MAX_HANDOFF_DEPTH): HandoffDecision {
  if (!request?.toBot?.trim() || !request?.task?.trim()) {
    return { allowed: false, reason: "a handoff needs both a target bot and a task" };
  }
  if (request.toBot.trim().toLowerCase() === request.fromBot.trim().toLowerCase()) {
    return { allowed: false, reason: "a bot cannot delegate a task to itself" };
  }
  if (!Number.isFinite(request.depth) || request.depth > maxDepth) {
    return { allowed: false, reason: `handoff chain exceeded ${maxDepth} hops` };
  }

  const delegatedTask = delegatedTaskFor(request);

  // A bot must not be able to do through a peer what it would have needed the user's approval for
  // itself, so a delegated task goes through the same gate as a task typed into /api/run.
  const risk = assessTaskRisk(delegatedTask);
  if (risk.blocked) {
    return { allowed: false, reason: risk.reason ?? "blocked by the credential-exposure rule" };
  }
  if (risk.approvalsRequired.length > 0) {
    return {
      allowed: false,
      reason: `the delegated task needs your approval first (${risk.approvalsRequired.join(", ")}); ask ${request.toBot} directly`
    };
  }

  return { allowed: true, delegatedTask };
}


/** A coordinator consultation asks for a reply, never browser work on its behalf. */
export function handoffExecutionContext(request: AgentHandoffRequest) {
  return {
    interactionMode: request.discussionId ? "chat" as const : request.interactionMode,
    sessionMode: request.sessionMode,
    agentEngine: request.agentEngine
  };
}
