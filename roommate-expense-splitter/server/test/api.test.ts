import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("authenticated household expenses validate IDs, membership, payer and custom shares", async () => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  const { app } = await import("../src/index");
  const { db } = await import("../src/db");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function request(route: string, body?: unknown, cookie = "") {
    return fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
  }
  try {
    assert.equal((await request("/api/groups")).status, 401);
    const signup = async (name: string) => {
      const response = await request("/api/auth/signup", { name, email: `${name}@example.test`, password: "test-password-only" });
      assert.equal(response.status, 201);
      return { cookie: response.headers.get("set-cookie")!.split(";")[0], user: (await response.json()).user };
    };
    const alice = await signup("Alice");
    const bob = await signup("Bob");
    const created = await request("/api/groups", { name: "Home" }, alice.cookie);
    const { group } = await created.json();
    assert.equal(created.status, 201);
    assert.equal((await request(`/api/groups/${group.id}`, undefined, bob.cookie)).status, 404);
    assert.equal((await request("/api/groups/join", { inviteCode: group.inviteCode }, bob.cookie)).status, 200);
    for (const suffix of ["", "/balances", "/expenses"]) {
      assert.equal((await request(`/api/groups/invalid${suffix}`, suffix === "/expenses" ? {} : undefined, alice.cookie)).status, 400);
    }
    const expense = await request(`/api/groups/${group.id}/expenses`, {
      description: "Groceries", amount: "12.34", payerId: bob.user.id, splitType: "equal"
    }, alice.cookie);
    assert.equal(expense.status, 201);
    const result = await (await request(`/api/groups/${group.id}/balances`, undefined, alice.cookie)).json();
    assert.deepEqual(result.payments, [{ fromUserId: alice.user.id, from: "Alice", toUserId: bob.user.id, to: "Bob", cents: 617 }]);
    assert.equal((await request(`/api/groups/${group.id}/expenses`, {
      description: "Bad shares", amount: "10", splitType: "custom", splits: [{ userId: alice.user.id, cents: 1 }]
    }, alice.cookie)).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
});

test("production refuses missing and example session secrets", () => {
  for (const secret of ["", "replace-this-with-a-random-secret-at-least-32-characters"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DATABASE_PATH: ":memory:", NODE_ENV: "production", SESSION_SECRET: secret },
      encoding: "utf8", timeout: 5000
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SESSION_SECRET must be/);
  }
});
