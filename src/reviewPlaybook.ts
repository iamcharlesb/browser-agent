import { redactSecrets } from "./security";
/** Local owner CLI. This review action is intentionally not an agent tool. */
import "./environment";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { PlaybookStore } from "./playbookStore";
import { closeUserStoreConnections } from "./userStore";

async function main() {
  const { values } = parseArgs({ options: {
    list: { type: "boolean" }, show: { type: "boolean" }, bot: { type: "string" }, proposal: { type: "string" }, decision: { type: "string" },
    reviewer: { type: "string" }, revision: { type: "string" }
  } });
  const store = new PlaybookStore(join(__dirname, "..", ".browser-agent-playbooks"));
  if (values.list && values.bot) {
    console.log(redactSecrets(JSON.stringify(await store.proposals(values.bot), null, 2)));
    return;
  }
  if (values.show && values.bot && values.proposal) {
    console.log(redactSecrets(JSON.stringify({ proposal: await store.proposal(values.bot, values.proposal), current: await store.approved(values.bot) }, null, 2)));
    return;
  }
  if (!values.bot || !values.proposal || !values.reviewer || values.revision === undefined || !["approve", "reject"].includes(values.decision || "")) {
    throw new Error("Usage: profiles:review -- --bot BOT_ID --proposal UUID --decision approve|reject --reviewer OWNER --revision CURRENT_REVISION. Inspect first with --show --bot BOT_ID --proposal UUID.");
  }
  const record = await store.review({ botId: values.bot, proposalId: values.proposal,
    reviewer: values.reviewer, expectedRevision: Number(values.revision), decision: values.decision as "approve" | "reject" });
  console.log(JSON.stringify({ botId: record.botId, revision: record.revision, decision: values.decision }));
}
void main().catch(error => { console.error(redactSecrets(error instanceof Error ? error.message : "Review failed.")); process.exitCode = 1; }).finally(closeUserStoreConnections);
