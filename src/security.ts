export type ApprovalCategory = "financial_transaction" | "external_side_effect";

export interface RiskAssessment {
  blocked: boolean;
  reason?: string;
  approvalsRequired: ApprovalCategory[];
}

const SECRET_PATTERNS = [
  /\b(?:show|reveal|print|post|publish|send|share|expose|upload)\b.{0,80}\b(?:password|credential|api[ _-]?key|access token|secret|cookie|session token)\b/i,
  /\b(?:password|credential|api[ _-]?key|access token|secret|cookie|session token)\b.{0,80}\b(?:public|github|bitbucket|website|social media|pastebin)\b/i
];

const MONEY_PATTERN =
  /\b(?:buy|purchase|pay|checkout|subscribe|transfer|send money|wire|invest|trade\s+(?:stocks?|shares?|crypto(?:currency)?|bitcoin|securities|options?|futures|forex|assets?)|place an order|confirm payment|book and pay)\b/i;
const EXTERNAL_SIDE_EFFECT_PATTERN =
  /\b(?:publish|unfollow|send (?:an? )?(?:email|message|dm)|create account|submit form|delete|cancel)\b|\bpost\s+(?:this|that|the|a|an|it|on|to)\b|\bfollow\s+@[\w.-]+\b|\bfollow\s+(?:(?:this|that|the|a|an|my|our)\s+)?(?:accounts?|people|users?|profiles?|creators?|friends?|brands?|pages?|channels?|influencers?)\b|\bcomment\s+(?:on|under|to)\b/i;
// "like" is common in ordinary prose ("like Codex" / "I like this video"). Only flag
// explicit social-media targets, so bot descriptions don't accidentally require approval.
const SOCIAL_LIKE_PATTERN =
  /\b(?:like|react to)\s+(?:(?:this|that|the|a|an)\s+)?(?:post|posts|photo|photos|image|images|video|videos|reel|reels|tweet|tweets|comment|comments)\b/i;
// Account/moderation changes that are real, visible side effects but don't match the
// publish/follow/delete wording above: blocking, muting, reporting, archiving, and editing
// profile fields (bio, picture, username, password, privacy/visibility settings).
const ACCOUNT_CHANGE_PATTERN =
  /\b(?:block|mute|report|archive|unarchive)\s+(?:(?:this|that|the|a|an|my|our)\s+)?(?:[a-z]+\s+){0,2}?(?:user|users|account|accounts|person|people|post|posts|profile|page)\b|\b(?:change|update|edit|set|swap)\s+(?:my\s+)?(?:bio|profile\s+picture|avatar|username|password|handle|display\s+name|privacy\s+settings?|visibility)\b/i;

// LinkedIn-style networking. "Connect" is LinkedIn's primary verb and was passing the gate
// completely: a connection request lands in a real person's inbox under the user's name and cannot
// be unsent cleanly. Scoped to people-ish objects so "connect to the database" stays ungated.
const NETWORK_CONNECT_PATTERN =
  /\bconnection\s+requests?\b|\bsend\s+(?:a\s+|the\s+|\d+\s+)?(?:connection\s+requests?|invit(?:es?|ations?))\b|\bconnect\s+(?:with|to)\s+(?:(?:these|those|the|my|all|some|\d+)\s+)?(?:\w+\s+){0,2}?(?:founders?|people|persons?|users?|prospects?|leads?|recruiters?|candidates?|contacts?|profiles?|accounts?|executives?|managers?|engineers?|developers?|marketers?|investors?|creators?)\b|\bconnect\s+(?:with|to)\s+@[\w.-]+|\binvite\s+[\w\s.@,'-]{0,40}?\bto\s+connect\b|\bendorse\s+(?:\w+\s+){0,2}?skills?\b|\b(?:accept|decline|withdraw)\s+(?:all\s+)?(?:my\s+|the\s+)?(?:pending\s+)?(?:connection\s+)?(?:invitations?|invites?|connection\s+requests?)\b/i;

// Cold-email and sequence platforms (Instantly, Lemlist, Apollo, Smartlead...). Starting a sequence
// sends real mail to real inboxes under the user's domain - it is irreversible and carries
// CAN-SPAM/GDPR obligations, so it is never something to fire without an explicit yes.
const OUTREACH_CAMPAIGN_PATTERN =
  /\b(?:launch|start|activate|resume|unpause|enable|kick\s*off)\s+(?:the\s+|my\s+|a\s+|this\s+)?(?:\w+\s+){0,2}?(?:campaign|sequence|drip|cadence|outreach|sending)\b|\b(?:start|begin)\s+sending\b|\bsend\s+(?:the\s+|these\s+|those\s+|all\s+|my\s+)?(?:\d+\s+)?(?:cold\s+|outreach\s+|follow[\s-]?up\s+)?emails?\b|\b(?:add|upload|import|enroll|push)\s+(?:these\s+|the\s+|my\s+|all\s+|this\s+)?(?:\d+\s+)?(?:leads?|contacts?|prospects?|lead\s+list|email\s+list)\b[\s\S]{0,40}?\b(?:campaign|sequence|instantly|lemlist|apollo|smartlead|outreach)\b/i;

export function assessTaskRisk(task: string): RiskAssessment {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(task))) {
    return {
      blocked: true,
      reason: "Tasks that expose or publish passwords, credentials, tokens, cookies, or API keys are blocked.",
      approvalsRequired: []
    };
  }
  const approvalsRequired: ApprovalCategory[] = [];
  // Inspect financial verbs in their clause so discussion of an article title or
  // a negated instruction does not turn the whole task into a purchase.
  const financialClauses = task.replace(/[“"][^“”"]*[”"]/g, "").split(/[.!?;\n]/);
  const financialAction = financialClauses.some(clause => {
    if (!MONEY_PATTERN.test(clause)) return false;
    if (/^\s*(?:please\s+)?plan\b/i.test(clause)) return false;
    if (/\b(?:why|whether|explain|discuss|research|analy[sz]e|compare|draft|write)\b/i.test(clause) &&
        !/\b(?:then|and)\s+(?:buy|purchase|pay|checkout|transfer|subscribe)\b/i.test(clause)) return false;
    return !/\b(?:do not|don't|never|without|before)\s+(?:\w+\s+){0,3}(?:buy|purchase|pay|checkout|subscribe|transfer|invest|trade)\b/i.test(clause);
  });
  if (financialAction) approvalsRequired.push("financial_transaction");
  if (
    EXTERNAL_SIDE_EFFECT_PATTERN.test(task) ||
    SOCIAL_LIKE_PATTERN.test(task) ||
    ACCOUNT_CHANGE_PATTERN.test(task) ||
    NETWORK_CONNECT_PATTERN.test(task) ||
    OUTREACH_CAMPAIGN_PATTERN.test(task)
  ) {
    approvalsRequired.push("external_side_effect");
  }
  return { blocked: false, approvalsRequired };
}

/** Best-effort output redaction, not an execution sandbox or a secret manager. */
const secretName = /(?:api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|access[_-]?key|authorization|cookie|mongodb_uri|database_url)/i;

export function redactSecrets(value: string): string {
  let result = value;
  // Exact configured credentials catch opaque keys and provider-specific formats.
  const configured = Object.entries(process.env)
    .filter(([name, text]) => secretName.test(name) && text && text.length >= 8)
    .map(([, text]) => text!)
    .sort((a, b) => b.length - a.length);
  for (const secret of configured) {
    result = result.split(secret).join("[REDACTED]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) result = result.split(encoded).join("[REDACTED]");
  }
  return result
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:sk-(?:proj-|ant-)?|xai-|gh[pousr]_)[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/((?:["']?)(?:[\w-]*(?:password|passwd|secret|token|api[_-]?key|authorization|cookie))["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}]+)/gi,
      (_match, prefix: string, raw: string) => prefix + (raw.startsWith('"') ? '"[REDACTED]"' : raw.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]"));
}

/** Sanitize structured events without changing their shape or mutating live state. */
export function redactSecretValues<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(item => redactSecretValues(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      secretName.test(key) && typeof item === "string" ? "[REDACTED]" : redactSecretValues(item)
    ])) as T;
  }
  return value;
}
