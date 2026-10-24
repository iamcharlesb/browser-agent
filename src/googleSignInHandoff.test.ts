import test from "node:test";
import assert from "node:assert/strict";
import { GoogleSignInHandoffStore } from "./googleSignInHandoff";

test("Google sign-in handoff waits for callback and exchanges once with its verifier", () => {
  const store = new GoogleSignInHandoffStore<{ credential: string }>();
  store.register("state-1", "verifier-1", 10_000, 0);

  assert.equal(store.isPending("state-1", 1), true);
  assert.deepEqual(store.exchange("state-1", "verifier-1", 1), { status: "pending" });
  assert.equal(store.complete("state-1", { credential: "id-token" }, 9_000, 2), true);
  assert.deepEqual(store.exchange("state-1", "wrong-verifier", 3), { status: "invalid" });
  assert.deepEqual(store.exchange("state-1", "verifier-1", 3), {
    status: "complete",
    value: { credential: "id-token" }
  });
  assert.deepEqual(store.exchange("state-1", "verifier-1", 4), { status: "invalid" });
});

test("Google sign-in handoff expires and cannot complete after expiry", () => {
  const store = new GoogleSignInHandoffStore<{ credential: string }>();
  store.register("state-2", "verifier-2", 100, 0);

  assert.equal(store.complete("state-2", { credential: "id-token" }, 200, 100), false);
  assert.deepEqual(store.exchange("state-2", "verifier-2", 100), { status: "invalid" });
});
