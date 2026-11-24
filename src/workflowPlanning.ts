import { resolveWorkspaceBot, type WorkspaceBot } from "./botCoordination";
import { assessTaskRisk, redactSecrets } from "./security";
import { type WorkflowOrchestrator, type WorkflowTaskDefinition } from "./workflowOrchestrator";

/** Model-authored plans are durable drafts, never approval grants or executable notifications. */
export async function planWorkflow(store: WorkflowOrchestrator, input: Record<string, unknown>, roster: WorkspaceBot[], context: string, model?: string, agentEngine?: WorkflowTaskDefinition["agentEngine"]) {
  if (input.action === "list") return { workflows: (await store.list()).map(({ id, status, tasks }) => ({ id, status, tasks: tasks.map(({ id, botName, status }) => ({ id, botName, status })) })) };
  if (input.action === "read") {
    const workflow = await store.get(String(input.id || ""));
    if (!workflow) throw new Error("Workflow not found.");
    return { workflow };
  }
  if (input.action !== "create") throw new Error("Use create, list or read. Execution starts from the Workflows panel.");
  if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 25) throw new Error("Provide 1–25 tasks.");
  const tasks: WorkflowTaskDefinition[] = input.tasks.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid workflow task.");
    const entry = raw as Record<string, unknown>;
    const bot = resolveWorkspaceBot(roster, String(entry.botName || ""));
    if (typeof entry.task !== "string") throw new Error("Each task needs a concrete instruction.");
    const risk = assessTaskRisk(entry.task);
    if (risk.blocked) throw new Error(risk.reason || "Blocked task.");
    if (risk.approvalsRequired.length) throw new Error("Draft preparation tasks only; publishing and spending require separately scoped approval.");
    if (entry.expectedOutput !== "text" && entry.expectedOutput !== "artifact") throw new Error("Each task needs expectedOutput: text or artifact.");
    if (entry.executionMode !== "text" && entry.executionMode !== "browser") throw new Error("Each task needs executionMode: text or browser.");
    if (typeof entry.acceptanceCriteria !== "string" || !entry.acceptanceCriteria.trim() || entry.acceptanceCriteria.length > 1500) throw new Error("Each task needs concrete acceptanceCriteria under 1500 characters.");
    if (entry.dependsOn !== undefined && (!Array.isArray(entry.dependsOn) || !entry.dependsOn.every(id => typeof id === "string"))) throw new Error("dependsOn must be an array of task IDs.");
    return { id: String(entry.id || ""), task: entry.task, botName: bot.name, profileId: bot.profileId,
      botInstructions: bot.botInstructions, expertise: bot.expertise, model, agentEngine, dependsOn: entry.dependsOn as string[] | undefined,
      executionMode: entry.executionMode, expectedOutput: entry.expectedOutput, acceptanceCriteria: redactSecrets(entry.acceptanceCriteria), context: redactSecrets(context).slice(0, 6000), approvedCategories: [] };
  });
  const workflow = await store.create(tasks);
  return { workflow, message: "Saved draft. No bots started. Review task owners, outputs and acceptance criteria in Workflows, then use Start workflow. Runtime output checks establish delivery, not semantic correctness; review the artifacts before publishing." };
}
