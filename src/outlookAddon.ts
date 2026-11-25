import { redactSecrets } from "./security";

export type OutlookAction =
  | "status"
  | "list_messages"
  | "search_messages"
  | "get_message"
  | "create_draft"
  | "send_email"
  | "reply_email"
  | "list_events";

export interface OutlookInput {
  action: OutlookAction;
  folder?: string;
  query?: string;
  messageId?: string;
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  body?: string;
  comment?: string;
  limit?: number;
  startDateTime?: string;
  endDateTime?: string;
}

export interface OutlookResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const ALLOWED_FOLDERS = new Set(["inbox", "sentitems", "drafts", "deleteditems", "junkemail", "archive"]);
const MAX_BODY_CHARS = 6000;

let cachedRefreshedToken: { token: string; expiresAt: number; cacheKey: string } | null = null;

export function clearOutlookTokenCache(): void {
  cachedRefreshedToken = null;
}

function normalizeRecipients(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : input.split(/[,;]+/);
  return raw
    .map((entry) => entry.trim())
    .filter((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry));
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function resolveAccessToken(
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
  signal?: AbortSignal
): Promise<string> {
  const direct = env.OUTLOOK_ACCESS_TOKEN?.trim();
  const refreshToken = env.OUTLOOK_REFRESH_TOKEN?.trim();
  const clientId = env.OUTLOOK_CLIENT_ID?.trim();
  const clientSecret = env.OUTLOOK_CLIENT_SECRET?.trim();
  const tenantId = env.OUTLOOK_TENANT_ID?.trim() || "common";

  if (refreshToken && clientId) {
    const cacheKey = `${tenantId}:${clientId}:${refreshToken.slice(-8)}`;
    if (cachedRefreshedToken && cachedRefreshedToken.cacheKey === cacheKey && Date.now() < cachedRefreshedToken.expiresAt) {
      return cachedRefreshedToken.token;
    }
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "https://graph.microsoft.com/.default offline_access"
    });
    if (clientSecret) form.set("client_secret", clientSecret);
    const resp = await fetchFn(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal
    });
    const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok || typeof payload.access_token !== "string" || !payload.access_token) {
      const errDesc = typeof payload.error_description === "string"
        ? payload.error_description
        : `HTTP ${resp.status}`;
      throw new Error(`Microsoft token refresh failed: ${redactSecrets(errDesc).slice(0, 200)}`);
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3000;
    cachedRefreshedToken = {
      token: payload.access_token,
      expiresAt: Date.now() + Math.max(60, expiresIn - 120) * 1000,
      cacheKey
    };
    return payload.access_token;
  }

  if (direct) return direct;
  throw new Error(
    "Outlook addon is not configured. Open Marketplace → Microsoft Outlook → Configure and add OUTLOOK_ACCESS_TOKEN (or OUTLOOK_CLIENT_ID + OUTLOOK_REFRESH_TOKEN)."
  );
}

async function graphRequest(
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
    env: NodeJS.ProcessEnv;
    fetchFn: typeof fetch;
    signal?: AbortSignal;
  }
): Promise<{ status: number; data: Record<string, unknown> }> {
  const token = await resolveAccessToken(options.env, options.fetchFn, options.signal);
  const resp = await options.fetchFn(`${GRAPH_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.extraHeaders || {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal
  });

  if (resp.status === 202 || resp.status === 204) {
    return { status: resp.status, data: {} };
  }
  const text = await resp.text();
  let parsed: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
  }
  if (!resp.ok) {
    const graphError = parsed.error as Record<string, unknown> | undefined;
    const code = typeof graphError?.code === "string" ? graphError.code : `HTTP_${resp.status}`;
    const msg = typeof graphError?.message === "string" ? graphError.message : `Graph request failed (${resp.status})`;
    throw new Error(`Microsoft Graph ${code}: ${redactSecrets(msg).slice(0, 240)}`);
  }
  return { status: resp.status, data: parsed };
}

function formatAddress(addr: unknown): string {
  const emailAddr = (addr as { emailAddress?: { name?: string; address?: string } } | undefined)?.emailAddress;
  if (!emailAddr) return "(unknown)";
  if (emailAddr.name && emailAddr.address && emailAddr.name !== emailAddr.address) {
    return `${emailAddr.name} <${emailAddr.address}>`;
  }
  return emailAddr.address || emailAddr.name || "(unknown)";
}

export async function runOutlookAction(
  input: OutlookInput,
  options?: { env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch; signal?: AbortSignal }
): Promise<OutlookResult> {
  const env = options?.env || process.env;
  const fetchFn = options?.fetchFn || fetch;
  const signal = options?.signal;
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 25);

  try {
    switch (input.action) {
      case "status": {
        const { data } = await graphRequest("/me?$select=displayName,mail,userPrincipalName", { env, fetchFn, signal });
        const displayName = String(data.displayName || "");
        const mail = String(data.mail || data.userPrincipalName || "");
        return {
          ok: true,
          message: `Connected to Microsoft Outlook as ${displayName || mail}${displayName && mail ? ` (${mail})` : ""}.`,
          data: { displayName, mail }
        };
      }

      case "list_messages": {
        const rawFolder = (input.folder || "inbox").trim().toLowerCase();
        const folder = ALLOWED_FOLDERS.has(rawFolder) ? rawFolder : "inbox";
        const path = `/me/mailFolders/${folder}/messages?$top=${limit}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview&$orderby=receivedDateTime%20desc`;
        const { data } = await graphRequest(path, { env, fetchFn, signal });
        const items = Array.isArray(data.value) ? (data.value as Array<Record<string, unknown>>) : [];
        if (!items.length) {
          return { ok: true, message: `No messages found in Outlook ${folder}.`, data: { folder, count: 0, messages: [] } };
        }
        const lines = items.map((m, i) => {
          const unread = m.isRead === false ? "[UNREAD] " : "";
          const subject = String(m.subject || "(no subject)");
          const from = formatAddress(m.from);
          const date = String(m.receivedDateTime || "");
          const preview = String(m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 120);
          return `${i + 1}. ${unread}${subject} — From: ${from} (${date}) [id: ${String(m.id || "")}]\n   ${preview}`;
        });
        return {
          ok: true,
          message: `Outlook ${folder} (${items.length} message${items.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
          data: { folder, count: items.length }
        };
      }

      case "search_messages": {
        const query = (input.query || "").trim().replace(/"/g, "");
        if (!query) return { ok: false, message: "search_messages requires a non-empty query." };
        const encoded = encodeURIComponent(`"${query}"`);
        const path = `/me/messages?$search=${encoded}&$top=${limit}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview`;
        const { data } = await graphRequest(path, {
          env,
          fetchFn,
          signal,
          extraHeaders: { ConsistencyLevel: "eventual" }
        });
        const items = Array.isArray(data.value) ? (data.value as Array<Record<string, unknown>>) : [];
        if (!items.length) {
          return { ok: true, message: `No Outlook messages matched "${query}".`, data: { query, count: 0 } };
        }
        const lines = items.map((m, i) => {
          const subject = String(m.subject || "(no subject)");
          const from = formatAddress(m.from);
          const date = String(m.receivedDateTime || "");
          const preview = String(m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 120);
          return `${i + 1}. ${subject} — From: ${from} (${date}) [id: ${String(m.id || "")}]\n   ${preview}`;
        });
        return {
          ok: true,
          message: `Outlook search for "${query}" (${items.length} match${items.length === 1 ? "" : "es"}):\n${lines.join("\n")}`,
          data: { query, count: items.length }
        };
      }

      case "get_message": {
        const messageId = (input.messageId || "").trim();
        if (!messageId) return { ok: false, message: "get_message requires a messageId." };
        const path = `/me/messages/${encodeURIComponent(messageId)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,body`;
        const { data } = await graphRequest(path, { env, fetchFn, signal });
        const bodyObj = data.body as { contentType?: string; content?: string } | undefined;
        const rawBody = String(bodyObj?.content || "");
        const textBody = (bodyObj?.contentType === "html" ? stripHtml(rawBody) : rawBody.trim()).slice(0, MAX_BODY_CHARS);
        const toList = Array.isArray(data.toRecipients) ? data.toRecipients.map(formatAddress).join(", ") : "";
        const ccList = Array.isArray(data.ccRecipients) ? data.ccRecipients.map(formatAddress).join(", ") : "";
        const headerLines = [
          `Subject: ${String(data.subject || "(no subject)")}`,
          `From: ${formatAddress(data.from)}`,
          toList ? `To: ${toList}` : "",
          ccList ? `Cc: ${ccList}` : "",
          `Received: ${String(data.receivedDateTime || "")}`
        ].filter(Boolean);
        return {
          ok: true,
          message: `${headerLines.join("\n")}\n\n${textBody || "(empty body)"}`,
          data: { id: data.id, subject: data.subject }
        };
      }

      case "create_draft": {
        const to = normalizeRecipients(input.to);
        const cc = normalizeRecipients(input.cc);
        const subject = (input.subject || "").trim();
        const body = (input.body || "").trim();
        if (!subject && !body) return { ok: false, message: "create_draft requires a subject or body." };
        const payload = {
          subject: subject || "(no subject)",
          body: { contentType: "Text", content: body },
          ...(to.length ? { toRecipients: to.map((address) => ({ emailAddress: { address } })) } : {}),
          ...(cc.length ? { ccRecipients: cc.map((address) => ({ emailAddress: { address } })) } : {})
        };
        const { data } = await graphRequest("/me/messages", { method: "POST", body: payload, env, fetchFn, signal });
        return {
          ok: true,
          message: `Saved Outlook draft "${String(data.subject || subject)}" (id: ${String(data.id || "created")}).`,
          data: { id: data.id, subject: data.subject }
        };
      }

      case "send_email": {
        const to = normalizeRecipients(input.to);
        const cc = normalizeRecipients(input.cc);
        const subject = (input.subject || "").trim();
        const body = (input.body || "").trim();
        if (!to.length) return { ok: false, message: "send_email requires at least one valid recipient email in 'to'." };
        if (!subject) return { ok: false, message: "send_email requires a non-empty subject." };
        if (!body) return { ok: false, message: "send_email requires a non-empty body." };
        await graphRequest("/me/sendMail", {
          method: "POST",
          body: {
            message: {
              subject,
              body: { contentType: "Text", content: body },
              toRecipients: to.map((address) => ({ emailAddress: { address } })),
              ...(cc.length ? { ccRecipients: cc.map((address) => ({ emailAddress: { address } })) } : {})
            },
            saveToSentItems: true
          },
          env,
          fetchFn,
          signal
        });
        return {
          ok: true,
          message: `Sent Outlook email "${subject}" to ${to.join(", ")}.`,
          data: { to, cc, subject }
        };
      }

      case "reply_email": {
        const messageId = (input.messageId || "").trim();
        const comment = (input.comment || input.body || "").trim();
        if (!messageId) return { ok: false, message: "reply_email requires a messageId." };
        if (!comment) return { ok: false, message: "reply_email requires a non-empty comment or body." };
        await graphRequest(`/me/messages/${encodeURIComponent(messageId)}/reply`, {
          method: "POST",
          body: { comment },
          env,
          fetchFn,
          signal
        });
        return {
          ok: true,
          message: `Sent Outlook reply to message ${messageId}.`,
          data: { messageId }
        };
      }

      case "list_events": {
        const start = input.startDateTime?.trim();
        const end = input.endDateTime?.trim();
        const path =
          start && end
            ? `/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=${limit}&$select=id,subject,start,end,organizer,location,isOnlineMeeting&$orderby=start/dateTime`
            : `/me/events?$top=${limit}&$select=id,subject,start,end,organizer,location,isOnlineMeeting&$orderby=start/dateTime`;
        const { data } = await graphRequest(path, { env, fetchFn, signal });
        const items = Array.isArray(data.value) ? (data.value as Array<Record<string, unknown>>) : [];
        if (!items.length) {
          return { ok: true, message: "No Outlook calendar events found.", data: { count: 0 } };
        }
        const lines = items.map((ev, i) => {
          const subject = String(ev.subject || "(untitled event)");
          const evStart = (ev.start as { dateTime?: string; timeZone?: string } | undefined)?.dateTime || "";
          const evEnd = (ev.end as { dateTime?: string; timeZone?: string } | undefined)?.dateTime || "";
          const loc = (ev.location as { displayName?: string } | undefined)?.displayName || "";
          const online = ev.isOnlineMeeting ? " [Online]" : "";
          return `${i + 1}. ${subject}${online} — ${evStart} → ${evEnd}${loc ? ` @ ${loc}` : ""}`;
        });
        return {
          ok: true,
          message: `Outlook calendar (${items.length} event${items.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
          data: { count: items.length }
        };
      }

      default:
        return { ok: false, message: `Unsupported Outlook action: ${String(input.action)}` };
    }
  } catch (error) {
    return {
      ok: false,
      message: redactSecrets((error as Error).message || "Outlook request failed.")
    };
  }
}
