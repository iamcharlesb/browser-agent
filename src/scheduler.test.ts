import assert from "node:assert/strict";
import { test } from "node:test";
import { nextDailyOccurrence } from "./scheduler";

test("daily schedule uses the requested local wall time", () => {
  const next = nextDailyOccurrence("America/Los_Angeles", "15:00", new Date("2026-10-17T18:00:00.000Z"));
  assert.equal(next.toISOString(), "2026-10-17T22:00:00.000Z");
});

test("daily schedule preserves local time across the daylight-saving transition", () => {
  const first = nextDailyOccurrence("America/Los_Angeles", "15:00", new Date("2026-10-31T18:00:00.000Z"));
  const nextDay = nextDailyOccurrence("America/Los_Angeles", "15:00", new Date(first.getTime() + 60_000));
  assert.equal(first.toISOString(), "2026-10-31T22:00:00.000Z");
  assert.equal(nextDay.toISOString(), "2026-11-01T23:00:00.000Z");
});

test("invalid daily times and timezones are rejected", () => {
  assert.throws(() => nextDailyOccurrence("America/Los_Angeles", "25:00"), /valid 24-hour time/);
  assert.throws(() => nextDailyOccurrence("No/Such_Zone", "15:00"), /valid IANA timezone/);
});
