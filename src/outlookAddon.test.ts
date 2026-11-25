import test from "node:test";
import assert from "node:assert/strict";
import { clearOutlookTokenCache, runOutlookAction } from "./outlookAddon";

function mockResponse(status: number, body: unknown): Response {
  return new Response(status === 202 || status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("outlookAddon reports setup guidance when unconfigured", async () => {
  clearOutlookTokenCache();
  const res = await runOutlookAction({ action: "status" }, { env: {} });
  assert.equal(res.ok, false);
  assert.match(res.message, /Marketplace/i);
  assert.match(res.message, /OUTLOOK_ACCESS_TOKEN/);
});

test("outlookAddon supports status, list, search, get (HTML strip), draft, send, reply, and calendar events", async () => {
  clearOutlookTokenCache();
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });

    if (url.includes("/me?$select=displayName")) {
      return mockResponse(200, { displayName: "Ada Lovelace", mail: "ada@example.com" });
    }
    if (url.includes("/me/mailFolders/inbox/messages")) {
      return mockResponse(200, {
        value: [
          {
            id: "msg-1",
            subject: "Q4 Roadmap",
            from: { emailAddress: { name: "Grace", address: "grace@example.com" } },
            receivedDateTime: "2026-11-24T10:00:00Z",
            isRead: false,
            bodyPreview: "Please review the Q4 milestones."
          }
        ]
      });
    }
    if (url.includes("/me/messages?$search=")) {
      return mockResponse(200, {
        value: [
          {
            id: "msg-2",
            subject: "Invoice #42",
            from: { emailAddress: { address: "billing@example.com" } },
            receivedDateTime: "2026-11-20T09:00:00Z",
            isRead: true,
            bodyPreview: "Attached invoice."
          }
        ]
      });
    }
    if (url.includes("/me/messages/msg-1?")) {
      return mockResponse(200, {
        id: "msg-1",
        subject: "Q4 Roadmap",
        from: { emailAddress: { name: "Grace", address: "grace@example.com" } },
        toRecipients: [{ emailAddress: { address: "ada@example.com" } }],
        receivedDateTime: "2026-11-24T10:00:00Z",
        body: { contentType: "html", content: "<div><p>Hello <b>Ada</b></p><script>alert(1)</script></div>" }
      });
    }
    if (url.endsWith("/me/messages") && method === "POST") {
      return mockResponse(201, { id: "draft-9", subject: "Follow-up" });
    }
    if (url.endsWith("/me/sendMail") && method === "POST") {
      return mockResponse(202, {});
    }
    if (url.endsWith("/me/messages/msg-1/reply") && method === "POST") {
      return mockResponse(202, {});
    }
    if (url.includes("/me/events?")) {
      return mockResponse(200, {
        value: [
          {
            id: "ev-1",
            subject: "Weekly Sync",
            start: { dateTime: "2026-11-25T16:00:00" },
            end: { dateTime: "2026-11-25T16:30:00" },
            location: { displayName: "Teams" },
            isOnlineMeeting: true
          }
        ]
      });
    }
    return mockResponse(404, { error: { code: "NotFound", message: "Unexpected URL" } });
  }) as typeof fetch;

  const env = { OUTLOOK_ACCESS_TOKEN: "test-access-token" };

  const statusRes = await runOutlookAction({ action: "status" }, { env, fetchFn });
  assert.equal(statusRes.ok, true);
  assert.match(statusRes.message, /Ada Lovelace/);

  const listRes = await runOutlookAction({ action: "list_messages", folder: "inbox", limit: 5 }, { env, fetchFn });
  assert.equal(listRes.ok, true);
  assert.match(listRes.message, /\[UNREAD\] Q4 Roadmap/);

  const searchRes = await runOutlookAction({ action: "search_messages", query: "Invoice" }, { env, fetchFn });
  assert.equal(searchRes.ok, true);
  assert.match(searchRes.message, /Invoice #42/);

  const getRes = await runOutlookAction({ action: "get_message", messageId: "msg-1" }, { env, fetchFn });
  assert.equal(getRes.ok, true);
  assert.match(getRes.message, /Hello Ada/);
  assert.equal(getRes.message.includes("alert(1)"), false);

  const draftRes = await runOutlookAction(
    { action: "create_draft", to: "grace@example.com", subject: "Follow-up", body: "Looks good." },
    { env, fetchFn }
  );
  assert.equal(draftRes.ok, true);
  assert.match(draftRes.message, /draft-9/);

  const sendRes = await runOutlookAction(
    { action: "send_email", to: "grace@example.com", subject: "Follow-up", body: "Shipped." },
    { env, fetchFn }
  );
  assert.equal(sendRes.ok, true);
  assert.match(sendRes.message, /Sent Outlook email/);

  const replyRes = await runOutlookAction(
    { action: "reply_email", messageId: "msg-1", comment: "Thanks!" },
    { env, fetchFn }
  );
  assert.equal(replyRes.ok, true);
  assert.match(replyRes.message, /Sent Outlook reply/);

  const eventsRes = await runOutlookAction({ action: "list_events" }, { env, fetchFn });
  assert.equal(eventsRes.ok, true);
  assert.match(eventsRes.message, /Weekly Sync \[Online\]/);

  const invalidSend = await runOutlookAction({ action: "send_email", to: "not-an-email", subject: "Hi", body: "Test" }, { env, fetchFn });
  assert.equal(invalidSend.ok, false);
  assert.match(invalidSend.message, /valid recipient/i);
});

test("outlookAddon exchanges refresh token when configured", async () => {
  clearOutlookTokenCache();
  let tokenFetches = 0;
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("login.microsoftonline.com")) {
      tokenFetches += 1;
      return mockResponse(200, { access_token: "minted-token", expires_in: 3600 });
    }
    return mockResponse(200, { displayName: "Refreshed User", mail: "refreshed@example.com" });
  }) as typeof fetch;

  const env = {
    OUTLOOK_TENANT_ID: "common",
    OUTLOOK_CLIENT_ID: "client-id-123",
    OUTLOOK_REFRESH_TOKEN: "refresh-token-xyz"
  };

  const first = await runOutlookAction({ action: "status" }, { env, fetchFn });
  const second = await runOutlookAction({ action: "status" }, { env, fetchFn });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(tokenFetches, 1, "refreshed access token should be cached");
});
