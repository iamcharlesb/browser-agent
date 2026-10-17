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
  /\b(?:buy|purchase|pay|checkout|subscribe|transfer|send money|wire|invest|trade|place an order|confirm payment|book and pay)\b/i;
const EXTERNAL_SIDE_EFFECT_PATTERN =
  /\b(?:publish|unfollow|send (?:an? )?(?:email|message|dm)|create account|submit form|delete|cancel)\b|\bpost\s+(?:this|that|the|a|an|it|on|to)\b|\bfollow\s+@[\w.-]+\b|\bfollow\s+(?:(?:this|that|the|a|an|my|our)\s+)?(?:accounts?|people|users?|profiles?|creators?|friends?|brands?|pages?|channels?|influencers?)\b|\bcomment\s+(?:on|under|to)\b/i;
// "like" is common in ordinary prose ("like Codex" / "I like this video"). Only flag
// explicit social-media targets, so bot descriptions don't accidentally require approval.
const SOCIAL_LIKE_PATTERN =
  /\b(?:like|react to)\s+(?:(?:this|that|the|a|an)\s+)?(?:post|posts|photo|photos|image|images|video|videos|reel|reels|tweet|tweets|comment|comments)\b/i;

export function assessTaskRisk(task: string): RiskAssessment {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(task))) {
    return {
      blocked: true,
      reason: "Tasks that expose or publish passwords, credentials, tokens, cookies, or API keys are blocked.",
      approvalsRequired: []
    };
  }
  const approvalsRequired: ApprovalCategory[] = [];
  if (MONEY_PATTERN.test(task)) approvalsRequired.push("financial_transaction");
  if (EXTERNAL_SIDE_EFFECT_PATTERN.test(task) || SOCIAL_LIKE_PATTERN.test(task)) {
    approvalsRequired.push("external_side_effect");
  }
  return { blocked: false, approvalsRequired };
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~-]{16,}\b/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/((?:password|secret|token|api[ _-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
