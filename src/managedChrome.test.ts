import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeLaunchArgs, ensureManagedChrome } from "./managedChrome";

test("managed Chrome uses a dedicated profile and local debugging without automation or security-disabling flags", () => {
  const args = chromeLaunchArgs("http://127.0.0.1:9222", "/tmp/profile with spaces");
  assert.ok(args.includes("--user-data-dir=/tmp/profile with spaces"));
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(args.includes("--remote-debugging-port=9222"));
  assert.equal(args.some(arg => /disable-web-security|ignore-certificate|user-agent|enable-automation/.test(arg)), false);
});

test("automatic startup refuses remote hosts and malformed debugging endpoints", () => {
  for (const url of ["https://127.0.0.1:9222", "http://example.com:9222", "http://127.0.0.1:9222/path", "http://user:pass@127.0.0.1:9222", "http://127.0.0.1:9222/?x=1"]) {
    assert.throws(() => chromeLaunchArgs(url, "/tmp/test-profile"));
  }
});

test("an already-running connected browser is reused without launching another Chrome", async () => {
  let calls = 0;
  await ensureManagedChrome("http://127.0.0.1:9222", "/tmp/unused", async () => { calls++; return true; });
  assert.equal(calls, 1);
});
