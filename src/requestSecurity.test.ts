import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { isSameOriginRequest, requestRejection } from "./requestSecurity";

function request(method: string, origin?: string, host = "127.0.0.1:8765", forwarded?: string): IncomingMessage {
  return { method, headers: { host, ...(origin === undefined ? {} : { origin }), "x-forwarded-proto": forwarded },
    socket: { localPort: 8765 } } as unknown as IncomingMessage;
}
test("all mutations reject absent, foreign and null origins before route dispatch", () => {
  for (const path of ["/api/terminal", "/api/run", "/api/approval", "/api/schedules", "/api/learn", "/api/login/input", "/api/attachments"]) {
    for (const origin of [undefined, "null", "https://example.invalid", "http://localhost:8765"]) {
      assert.ok(requestRejection(request("POST", origin), path, "127.0.0.1", 8765), path);
    }
    assert.equal(requestRejection(request("POST", "http://127.0.0.1:8765"), path, "127.0.0.1", 8765), null);
  }
  for (const method of ["DELETE", "PUT", "PATCH"]) {
    assert.ok(requestRejection(request(method), "/api/schedules/id", "127.0.0.1", 8765));
  }
});
test("host validation rejects DNS rebinding even when Origin matches", () => {
  for (const host of ["example.invalid:8765", "127.0.0.1.example.invalid:8765", "127.0.0.1:9999", "user@127.0.0.1:8765"]) {
    assert.ok(requestRejection(request("GET", `http://${host}`, host), "/api/status", "127.0.0.1", 8765));
  }
  assert.equal(requestRejection(request("GET"), "/api/status", "127.0.0.1", 8765), null);
});
test("untrusted proxy headers cannot change the expected origin", () => {
  assert.equal(isSameOriginRequest(request("POST", "https://127.0.0.1:8765", undefined, "https")), false);
});
test("only the Google callback bypasses Origin checks and Host is still checked", () => {
  const foreign = request("POST", "https://accounts.google.com");
  assert.equal(requestRejection(foreign, "/api/auth/google/callback", "127.0.0.1", 8765), null);
  assert.ok(requestRejection(foreign, "/api/auth/google/exchange", "127.0.0.1", 8765));
  assert.ok(requestRejection(request("POST", "https://accounts.google.com", "evil.invalid:8765"), "/api/auth/google/callback", "127.0.0.1", 8765));
});
