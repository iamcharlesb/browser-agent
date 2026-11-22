import test from "node:test";
import assert from "node:assert/strict";
import { parseHuddleParticipants } from "./huddle";
const bots = [{ id: "seo", name: "SEO Specialist" }, { id: "writer", name: "Blog Writer" }, { id: "founder", name: "Founder Operator" }];
test("huddle membership uses exact saved identities and preserves selected order", () => {
  assert.deepEqual(parseHuddleParticipants(["writer", "seo"], bots, "Huddle: Launch", 4), ["writer", "seo"]);
  assert.equal(parseHuddleParticipants(undefined, bots, "Huddle: Launch", 4), undefined);
});
test("huddles reject missing, duplicate, ambiguous, self and over-budget participants", () => {
  for (const value of [[], ["seo"], ["seo", "missing"], ["seo", "seo"], ["seo", 2], "seo,writer"]) assert.throws(() => parseHuddleParticipants(value, bots, "Huddle: Launch", 4));
  assert.throws(() => parseHuddleParticipants(["seo", "writer", "founder"], bots, "Huddle: Launch", 2), /between 2 and 2/);
  assert.throws(() => parseHuddleParticipants(["seo", "writer"], bots, "SEO Specialist", 4), /separate/);
  assert.throws(() => parseHuddleParticipants(["seo", "writer"], [{...bots[0], name: "Same"}, {...bots[1], name: "Same"}], "Huddle", 4), /distinct names/);
});
