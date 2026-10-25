import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { storeRunOutcome, readRunOutcome, outcomeEvent } from "./runOutcomes";

test("agent outcomes persist separately while event envelopes contain references only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcome-"));
  try {
    const record = await storeRunOutcome(directory, "Writer", { success: true, summary: "A long useful verified draft. ".repeat(100), stepsTaken: 2, elapsedSeconds: 1, terminationReason: "finish_task" });
    const event = outcomeEvent(record);
    assert.ok(JSON.stringify(event).length < 250);
    assert.equal(event.ref, record.id);
    assert.ok(!JSON.stringify(event).includes(record.result.summary));
    assert.equal((await readRunOutcome(directory, event.ref)).result.summary, record.result.summary);
    await assert.rejects(readRunOutcome(directory, "../../.env"), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
