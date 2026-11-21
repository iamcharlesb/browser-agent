import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSnapshot, feedItems, parseTrigger } from "./watchers";

const feed = (ids: string[]) => `<rss><channel>${ids.map(id => `<item><title>Post ${id}</title><link>https://example.test/${id}</link><guid>${id}</guid></item>`).join("")}</channel></rss>`;

test("a feed watch records a baseline, then wakes only for unseen items", () => {
  const trigger = { kind: "feed" as const, url: "https://example.test/rss" };
  const first = compareSnapshot(trigger, feed(["a", "b"]), {});
  assert.equal(first.changed, false);
  const quiet = compareSnapshot(trigger, feed(["a", "b"]), first.state);
  assert.equal(quiet.changed, false);
  const fresh = compareSnapshot(trigger, feed(["c", "a", "b"]), quiet.state);
  assert.equal(fresh.changed, true);
  assert.match(fresh.change, /1 new feed item\(s\):\n- Post c https:\/\/example.test\/c/);
  assert.deepEqual(fresh.state.seen?.slice(0, 1), ["c"]);
});

test("atom entries use their id and link href", () => {
  assert.deepEqual(feedItems('<feed><entry><id>tag:1</id><title><![CDATA[Hello]]></title><link href="https://example.test/1"/></entry></feed>'),
    [{ id: "tag:1", title: "Hello", link: "https://example.test/1" }]);
});

test("a page watch with a phrase wakes when the phrase appears, once", () => {
  const trigger = { kind: "page" as const, url: "https://example.test/item", contains: "In stock" };
  const absent = compareSnapshot(trigger, "Sold out", {});
  assert.equal(absent.changed, false);
  const present = compareSnapshot(trigger, "Now IN STOCK", absent.state);
  assert.equal(present.changed, true);
  assert.equal(compareSnapshot(trigger, "Now IN STOCK", present.state).changed, false);
});

test("a json watch compares only the value at its path", () => {
  const trigger = { kind: "json" as const, url: "https://example.test/api", path: "item.price" };
  const base = compareSnapshot(trigger, JSON.stringify({ item: { price: 10 }, fetchedAt: 1 }), {});
  assert.equal(compareSnapshot(trigger, JSON.stringify({ item: { price: 10 }, fetchedAt: 2 }), base.state).changed, false);
  const moved = compareSnapshot(trigger, JSON.stringify({ item: { price: 8 }, fetchedAt: 3 }), base.state);
  assert.equal(moved.changed, true);
  assert.match(moved.change, /item\.price is now: 8/);
});

test("triggers are validated", () => {
  assert.equal(parseTrigger(undefined), undefined);
  assert.throws(() => parseTrigger({ kind: "email", url: "https://example.test" }), /kind/);
  assert.throws(() => parseTrigger({ kind: "page", url: "ftp://example.test" }), /url/);
  assert.deepEqual(parseTrigger({ kind: "page", url: " https://example.test ", contains: "Sale" }), { kind: "page", url: "https://example.test", contains: "Sale" });
});
