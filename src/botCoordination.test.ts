import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationJournal, parseWorkspaceBots, requestedCoordination, resolveWorkspaceBot } from "./botCoordination";
import { decideHandoff } from "./handoff";

const roster = [{ id: "owner", name: "Coordinator" }, { id: "seo", name: "SEO Specialist", botInstructions: "Verify search evidence." },
  { id: "blog", name: "Blog Writer" }, { id: "reddit", name: "Reddit Community Growth" }, { id: "instagram", name: "Instagram Follower Growth" }];

test("explicit coordination selects saved peers while questions about prior contact start no work", () => {
  const bots = parseWorkspaceBots(roster)!;
  assert.deepEqual(requestedCoordination("sounds good, coordinate with all, weekly have rerto meeting", bots, "Coordinator").map(bot => bot.id), ["seo", "blog", "reddit", "instagram"]);
  assert.deepEqual(requestedCoordination("Check wth seo", bots, "Coordinator").map(bot => bot.id), ["seo"]);
  assert.deepEqual(requestedCoordination("Plan growth with @[SEO Specialist] and @[Reddit Community Growth]", bots, "Coordinator").map(bot => bot.id), ["seo", "reddit"]);
  assert.deepEqual(requestedCoordination("Ask @SEO and @Reddit for a joint plan", bots, "Coordinator").map(bot => bot.id), ["seo", "reddit"]);
  assert.deepEqual(requestedCoordination("did you talked with SEO bot?", bots, "Coordinator"), []);
  assert.deepEqual(requestedCoordination("Have you spoken with all the bots?", bots, "Coordinator"), []);
  assert.equal(resolveWorkspaceBot(bots, "seo").botInstructions, "Verify search evidence.");
  assert.equal(resolveWorkspaceBot(bots, "SEO bot").id, "seo");
  assert.throws(() => resolveWorkspaceBot(bots, "Made-up bot"), /No saved/);
  assert.throws(() => parseWorkspaceBots([roster[0], roster[0]]), /unique/);
});

test("read-only consultation can discuss a no-publishing plan but cannot run a financial request", () => {
  const request = { fromBot: "Coordinator", toBot: "SEO Specialist", depth: 1, discussionId: "admitted-discussion", task: "Review the organic strategy; do not publish anything." };
  assert.equal(decideHandoff(request).allowed, true);
  assert.equal(decideHandoff({ ...request, task: "buy the annual plan for me" }).allowed, false);
  assert.equal(decideHandoff({ ...request, discussionId: undefined, task: "Publish my article" }).allowed, false);
});

test("coordination receipts survive restart without restarting models or claiming interrupted work completed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coordination-journal-"));
  try {
    const file = join(directory, "records.json");
    const journal = new CoordinationJournal(file);
    journal.record({ id: "completed", discussionId: "team", fromBot: "Coordinator", toBot: "SEO Specialist", status: "completed", summary: "A historical search audit", generation: 50 });
    journal.record({ id: "pending", discussionId: "team", fromBot: "Coordinator", toBot: "Blog Writer", status: "queued", generation: 50 });
    const reopened = new CoordinationJournal(file);
    assert.equal(reopened.list("Coordinator")[0].status, "completed");
    assert.equal(reopened.list("Coordinator")[1].status, "interrupted");
    assert.deepEqual(reopened.list("Different bot"), []);
    reopened.record({ id: "pending", discussionId: "team", fromBot: "Coordinator", toBot: "Blog Writer", status: "failed" });
    assert.equal(reopened.list("Coordinator")[1].generation, 50);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
