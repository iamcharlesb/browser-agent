import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PlaybookStore, formatApprovedPlaybook, RevisionConflict, PlaybookUpdated } from "./playbookStore";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "reviewed-playbook-"));
  const store = new PlaybookStore(directory, async () => { throw Error("Local mode must not connect to MongoDB"); }, "local");
  return { directory, store, cleanup: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}
test("proposals cannot modify operational instructions until an explicit versioned review", async () => {
  const f = await fixture();
  try {
    const proposal = await f.store.propose("reddit", "Inspect community rules before drafting.", "user-correction:turn-3");
    assert.equal(proposal.status, "pending");
    assert.equal((await f.store.approved("reddit")).revision, 0);
    const approved = await f.store.review({ botId: "reddit", proposalId: proposal.id, decision: "approve", reviewer: "owner", expectedRevision: 0 });
    assert.equal(approved.revision, 1);
    assert.match(formatApprovedPlaybook(approved), /community rules/);
    const next = await f.store.propose("reddit", "Preserve the existing draft title.", "verified-outcome:2");
    await assert.rejects(f.store.review({ botId: "reddit", proposalId: next.id, decision: "approve", reviewer: "owner", expectedRevision: 0 }), RevisionConflict);
    assert.equal((await f.store.proposal("reddit", next.id))?.status, "pending");
    await assert.rejects(f.store.review({ botId: "reddit", proposalId: proposal.id, decision: "reject", reviewer: "owner", expectedRevision: 1 }), /retroactively/);
  } finally { await f.cleanup(); }
});
test("outcome notifications are compact, deduplicated and cause zero model activations", async () => {
  const f = await fixture();
  try {
    const events: PlaybookUpdated[] = [];
    f.store.subscribe(event => { events.push(event); });
    const proposal = await f.store.propose("writer", "Reopen the saved draft to verify persistence.", "outcome:7");
    const review = { botId: "writer", proposalId: proposal.id, decision: "approve" as const, reviewer: "owner", expectedRevision: 0 };
    await f.store.review(review);
    await f.store.review(review);
    assert.equal(events.length, 1);
    assert.equal(events[0].topic, "playbook.updated");
    assert.ok(JSON.stringify(events[0]).length < 300);
    assert.ok(!JSON.stringify(events[0]).includes(proposal.text));
    // Recreate the consumer: durable acknowledgment suppresses replayed snapshots.
    await f.store.close();
    const second = new PlaybookStore(f.directory, async () => null, "local");
    second.subscribe(event => { events.push(event); });
    await second.review(review);
    assert.equal(events.length, 1);
    await second.close();
  } finally { await f.cleanup(); }
});
test("rejected lessons and cross-bot references cannot enter a playbook", async () => {
  const f = await fixture();
  try {
    const proposal = await f.store.propose("writer", "Test this proposed lesson.", "evidence:1");
    await assert.rejects(f.store.review({ botId: "another", proposalId: proposal.id, decision: "approve", reviewer: "owner", expectedRevision: 0 }), /not found/);
    const record = await f.store.review({ botId: "writer", proposalId: proposal.id, decision: "reject", reviewer: "owner", expectedRevision: 0 });
    assert.equal(record.revision, 0);
    assert.equal((await f.store.proposal("writer", proposal.id))?.status, "rejected");
  } finally { await f.cleanup(); }
});
test("shared storage failure cannot silently fork an approved revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shared-playbook-"));
  const store = new PlaybookStore(directory, async () => null, "workspace-one");
  try {
    const proposal = await store.propose("bot", "Verify current scope.", "evidence:1");
    await assert.rejects(store.review({ botId: "bot", proposalId: proposal.id, decision: "approve", reviewer: "owner", expectedRevision: 0 }), /unavailable/);
    assert.equal((await store.approved("bot")).revision, 0);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Mongo-backed revisions synchronize between instances without mixing workspaces", async () => {
  const { EventEmitter } = await import("node:events");
  const records: any[] = [];
  const streams: any[] = [];
  const matches = (record: any, filter: any) => Object.entries(filter).every(([key, value]) => record[key] === value);
  const collection: any = {
    createIndex: async () => "workspace_index",
    findOne: async (filter: any) => records.find(record => matches(record, filter)) || null,
    updateOne: async (filter: any, update: any, options: any = {}) => {
      const existing = records.find(record => matches(record, filter));
      if (existing) {
        Object.assign(existing, update.$set || {});
        for (const stream of streams) if (existing.kind === "approved") stream.emit("change", { fullDocument: { ...existing } });
        return { matchedCount: 1, upsertedCount: 0 };
      }
      if (!options.upsert) return { matchedCount: 0, upsertedCount: 0 };
      const duplicate = records.find(record => record.workspaceId === filter.workspaceId && record.kind === filter.kind && record.botId === filter.botId && record.id === filter.id);
      if (duplicate) throw Object.assign(Error("duplicate revision"), { code: 11000 });
      const record = { ...filter, ...(update.$setOnInsert || update.$set) };
      records.push(record);
      for (const stream of streams) if (record.kind === "approved") stream.emit("change", { fullDocument: { ...record } });
      return { matchedCount: 0, upsertedCount: 1 };
    },
    find: (filter: any) => ({ async *[Symbol.asyncIterator]() { for (const record of records.filter(record => matches(record, filter))) yield { ...record }; } }),
    watch: (_pipeline: any, options: any) => {
      assert.equal(options.fullDocument, "updateLookup");
      const stream: any = new EventEmitter();
      stream.close = async () => { stream.emit("close"); };
      streams.push(stream); return stream;
    }
  };
  const database = async () => ({ collection: () => collection }) as any;
  const directories = await Promise.all([0, 1, 2].map(() => mkdtemp(join(tmpdir(), "mongo-playbook-"))));
  const first = new PlaybookStore(directories[0], database, "workspace-a");
  const second = new PlaybookStore(directories[1], database, "workspace-a");
  const other = new PlaybookStore(directories[2], database, "workspace-b");
  try {
    const events: PlaybookUpdated[] = [];
    second.subscribe(event => { events.push(event); });
    await new Promise(resolve => setImmediate(resolve));
    const proposal = await first.propose("research", "Verify the selected account.", "verified-turn:7");
    await first.review({ botId: "research", proposalId: proposal.id, decision: "approve", reviewer: "owner", expectedRevision: 0 });
    assert.equal((await second.approved("research")).revision, 1);
    assert.equal((await other.approved("research")).revision, 0);
    assert.equal(await other.proposal("research", proposal.id), null);
    for (let attempt = 0; attempt < 20 && !events.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events[0]?.revision, 1);
    assert.ok(!JSON.stringify(events).includes(proposal.text));
  } finally {
    await Promise.all([first.close(), second.close(), other.close()]);
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  }
});
