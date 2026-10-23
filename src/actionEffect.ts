/**
 * Effect-based action classification.
 *
 * The text-level gate in security.ts reads the *task* ("connect with 20 founders on LinkedIn") and
 * needs a new pattern for every platform someone thinks of. That does not scale to the hundreds of
 * sites a browser agent actually visits, and it fails open on the ones nobody wrote a pattern for.
 *
 * This module gates the *action* instead, at the moment it is about to happen. The insight that
 * makes it general: platforms are endless, but the verbs on their buttons are not. "Send", "Follow",
 * "Connect", "Publish", "Delete", "Pay" mean the same thing on LinkedIn, Instagram, Instantly,
 * Shopify, and a forum nobody has heard of. Classifying the button label covers every site at once,
 * including ones that did not exist when this was written.
 *
 * Two independent signals, and the gate takes the stricter of the two:
 *   1. declared  - the model says what it believes the click will do (it can see the screenshot and
 *                  knows the context: a bare "Save" on a profile-edit page is outward-facing).
 *   2. observed  - this module reads the real label/role of the element being clicked.
 *
 * The ratchet only turns one way: the model can raise the effect level, never lower it. A model that
 * claims "read" while clicking a button labelled "Delete account" still gets gated.
 *
 * Known limit, stated plainly: icon-only buttons (Instagram's heart, LinkedIn's connect icon) often
 * carry no readable label. For those, `observed` is null and the declaration is the only signal.
 * That is why the declaration exists rather than being decoration - the deterministic half is a
 * floor that catches careless or wrong declarations, not a complete classifier on its own.
 */

export type ActionEffect = "read" | "reversible" | "outward" | "irreversible";

/** Ordered so the gate can take a maximum. Higher = needs more consent. */
export const EFFECT_RANK: Record<ActionEffect, number> = {
  read: 0,
  reversible: 1,
  outward: 2,
  irreversible: 3
};

export const ACTION_EFFECTS: ActionEffect[] = ["read", "reversible", "outward", "irreversible"];

export function isActionEffect(value: unknown): value is ActionEffect {
  return typeof value === "string" && (ACTION_EFFECTS as string[]).includes(value);
}

export function maxEffect(a: ActionEffect, b: ActionEffect): ActionEffect {
  return EFFECT_RANK[a] >= EFFECT_RANK[b] ? a : b;
}

/** Tools that only observe. Never gated, whatever the model declares. */
const READ_ONLY_TOOLS = new Set([
  "navigate",
  "scroll",
  "screenshot",
  "read_page",
  "get_page_text",
  "wait",
  "go_back",
  "web_search",
  "calculate",
  "understand_youtube_video",
  "learning_kb"
]);

/** Tools that put a real event into the page. These are the ones worth classifying. */
export const INTERACTIVE_TOOLS = new Set([
  "click_mark",
  "type_mark",
  "click_element",
  "click_coords",
  "type_text",
  "key_press"
]);

/**
 * Whole-label nouns that name a destination rather than an action. "Followers" is a tab;
 * "Follow" is a button. Only consulted for link-ish roles, so Instagram's "Following" *button*
 * (which unfollows) still falls through to the verb table below.
 */
const NAV_NOUN_LABELS = new Set([
  "followers",
  "following",
  "connections",
  "network",
  "messages",
  "notifications",
  "likes",
  "comments",
  "posts",
  "feed",
  "home",
  "profile",
  "explore",
  "saved",
  "activity",
  "jobs",
  "campaigns",
  "sequences",
  "leads",
  "contacts",
  "prospects",
  "analytics",
  "dashboard",
  "inbox",
  "sent",
  "drafts",
  "settings",
  "about",
  "search"
]);

const LINK_ROLES = new Set(["link", "tab", "menuitem", "heading"]);

/**
 * Destructive or money-moving. Gated every single time - standing approval deliberately does not
 * reach this level, because "approve my follows for me" is not consent to spend money or delete
 * things. Bare "Delete" and "Remove" are included: the false-positive cost is one extra question,
 * the false-negative cost is unrecoverable.
 */
const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /\b(?:delete|erase|wipe|destroy|deactivate|permanently)\b/,
  /\bremove\b/,
  /\bclose\s+account\b/,
  /\b(?:pay|purchase|buy|checkout|check\s*out)\b/,
  /\bplace\s+(?:the\s+)?order\b/,
  /\bconfirm\s+(?:and\s+)?(?:pay|order|payment|purchase|booking|transfer|deletion|delete|cancellation)\b/,
  /\b(?:transfer|withdraw|donate|refund|chargeback)\b/,
  /\badd\s+(?:a\s+)?(?:payment|card|bank)\b/,
  /\b(?:upgrade|downgrade)\s+(?:plan|subscription)\b/,
  /\bcancel\s+(?:subscription|plan|order|booking|account|membership)\b/,
  /\bunsubscribe\b/,
  /\b(?:revoke|disconnect)\s+(?:access|account|integration)\b/
];

/**
 * Leaves the user's account and lands in front of other people. Reversible in the technical sense
 * sometimes (you can unsend, unfollow) but never in the social sense - the other person saw it.
 * Standing approval covers this level, which is exactly what the "Approve for me" toggle means.
 */
const OUTWARD_PATTERNS: RegExp[] = [
  // Inflections matter: Instagram labels its unfollow button "Following", LinkedIn labels a sent
  // invite "Pending". The suffix group deliberately excludes "followers", which is a nav link.
  /\b(?:un)?follow(?:s|ing|ed)?\b/,
  /\bconnect(?:s|ing|ed)?\b/,
  /\badd\s+(?:friend|connection|contact)\b/,
  /\b(?:send|resend)\b/,
  /\b(?:post|publish|share|repost|retweet|tweet|go\s+live)\b/,
  /\b(?:comment|reply)\b/,
  /\b(?:like|unlike|react|upvote|downvote|clap|favorite|favourite)\b/,
  /\b(?:endorse|recommend|vouch)\b/,
  // Archiving/hiding a post changes what other people can see, so it belongs here, not in reversible.
  /\b(?:archive|unarchive|block|mute|report)\b/,
  /\b(?:invite|rsvp)\b/,
  /\b(?:apply|submit)\b/,
  /\b(?:join|register|sign\s*up|enroll|subscribe)\b/,
  /\b(?:book|reserve)\b/,
  /\b(?:accept|decline|withdraw|approve|reject)\b/,
  /\b(?:launch|activate|resume|unpause)\b/,
  /\bstart\s+(?:campaign|sequence|sending|outreach|drip|cadence)\b/,
  /\bmessage\b/,
  /\bdm\b/,
  /\brequest\b/,
  /\bconfirm\b/
];

/** Changes only what this user sees, and they can put it back. Not worth interrupting anyone for. */
const REVERSIBLE_PATTERNS: RegExp[] = [
  /\b(?:save|bookmark|pin|star|watch)\b/,
  /\b(?:filter|sort|group|refine)\b/,
  /\b(?:select|choose|pick|check|uncheck|toggle)\b/,
  /\b(?:next|previous|prev|back|forward|continue|skip|more|less)\b/,
  /\b(?:close|dismiss|cancel|clear|reset|undo)\b/,
  /\b(?:expand|collapse|show|hide|view|open|preview)\b/,
  /\b(?:copy|download|export|print)\b/,
  /\b(?:edit|rename|draft|compose|write)\b/,
  /\b(?:refresh|reload|retry|load)\b/,
  /\b(?:upload|attach|browse)\b/,
  /\b(?:sign\s*in|log\s*in|login)\b/,
  /\b(?:ok|okay|got\s+it|done|got\s+this|understood|got)\b/,
  /\blearn\s+more\b/,
  /\bsee\s+(?:all|more)\b/
];

/** Field labels that mean the text being typed is destined for other people to read. */
const COMPOSER_FIELD_PATTERN =
  /\b(?:comment|reply|message|post|tweet|caption|note|dm|chat|write|compose|say\s+something|add\s+a\s+comment)\b/;

/**
 * `click_element` takes either visible text or a CSS selector. A selector is not a label - reading
 * verbs out of one is how `#post-list a` turns into "post" and prompts for a navigation click. When
 * the target is a selector there is no label signal, so the model's declaration stands alone.
 */
export function isCssSelector(target: string): boolean {
  const value = target.trim();
  if (!value) return false;
  if (/^[.#\[]/.test(value)) return true;
  if (/[>~]|::|\[[^\]]*\]/.test(value)) return true;
  // `div.card`, `a#main` - a tag name glued to a class/id, with no spaces to suggest prose.
  return /^[a-z][a-z0-9]*[.#][\w-]+/i.test(value) && !/\s/.test(value);
}

export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Classify a single element label. Returns null when the label carries no usable signal (empty,
 * icon-only, or a bare number) so callers can tell "safe" apart from "unknown".
 */
export function classifyLabel(label: string | undefined, role?: string): ActionEffect | null {
  const text = normalizeLabel(label ?? "");
  if (!text || /^[\d\s.,kmb+]+$/.test(text)) return null;

  // Checked strictest-first so "cancel subscription" cannot be read as a harmless "cancel".
  if (IRREVERSIBLE_PATTERNS.some((pattern) => pattern.test(text))) return "irreversible";

  // A destination, not a verb - but only when the role says it navigates. Instagram's "Following"
  // button unfollows; its "Followers" link does not.
  if (NAV_NOUN_LABELS.has(text) && LINK_ROLES.has((role ?? "").toLowerCase())) return "read";

  if (OUTWARD_PATTERNS.some((pattern) => pattern.test(text))) return "outward";
  if (REVERSIBLE_PATTERNS.some((pattern) => pattern.test(text))) return "reversible";
  if (NAV_NOUN_LABELS.has(text)) return "read";
  return null;
}

export interface BrowserActionContext {
  toolName: string;
  /** Visible text / aria-label of the element, when the caller could resolve one. */
  label?: string;
  role?: string;
  /** What the model said this action does. Untrusted: it can only raise the level, never lower it. */
  declaredEffect?: unknown;
  /** For typing tools - Enter is what turns a draft into a sent thing. */
  pressEnter?: boolean;
}

export interface EffectDecision {
  effect: ActionEffect;
  declared: ActionEffect | null;
  observed: ActionEffect | null;
  reason: string;
}

/**
 * Resolve the effect of one about-to-run tool call. Unknown signals fall back to "reversible"
 * rather than gating, because gating every unlabelled icon would make the agent unusable and train
 * the user to click Approve without reading - which is worse than no gate at all.
 */
export function classifyBrowserAction(context: BrowserActionContext): EffectDecision {
  const declared = isActionEffect(context.declaredEffect) ? context.declaredEffect : null;

  if (READ_ONLY_TOOLS.has(context.toolName)) {
    return { effect: "read", declared, observed: "read", reason: `${context.toolName} only observes` };
  }
  if (!INTERACTIVE_TOOLS.has(context.toolName)) {
    // Unknown tool: not this module's business. Other gates (privileged tools) still apply.
    return { effect: "read", declared, observed: null, reason: `${context.toolName} is not a page interaction` };
  }

  const isTyping = context.toolName === "type_mark" || context.toolName === "type_text";
  let observed = classifyLabel(context.label, context.role);
  let reason: string;

  if (isTyping) {
    const field = normalizeLabel(context.label ?? "");
    // Typing is drafting. Enter inside a composer is what actually posts it.
    observed =
      context.pressEnter && field && COMPOSER_FIELD_PATTERN.test(field)
        ? "outward"
        : observed === "irreversible"
          ? "irreversible"
          : "reversible";
    reason =
      observed === "outward"
        ? `typing + Enter into a composer field ("${context.label}")`
        : "typing text into a field is a draft until it is sent";
  } else if (observed) {
    reason = `element labelled "${context.label}" reads as ${observed}`;
  } else {
    reason = context.label
      ? `no verb recognised in "${context.label}"`
      : "element has no readable label (icon-only)";
  }

  // A known label stands on its own; the baseline is only for elements we could not read. The
  // declaration is then layered on top, and can only push the level up.
  const floor: ActionEffect = observed ?? "reversible";
  const effect = declared ? maxEffect(declared, floor) : floor;
  return { effect, declared, observed, reason };
}

/**
 * Standing approval ("Approve for me") covers outward engagement, which is the thing the user turns
 * it on for. It never covers irreversible or financial actions - those ask every time, by design.
 */
export function effectRequiresApproval(effect: ActionEffect, standingApproval: boolean): boolean {
  if (effect === "irreversible") return true;
  if (effect === "outward") return !standingApproval;
  return false;
}

export function describeEffectAction(toolName: string, label: string | undefined, effect: ActionEffect): string {
  const target = label ? `"${label.slice(0, 60)}"` : "an unlabelled element";
  if (toolName === "type_mark" || toolName === "type_text") return `Type into ${target} and send it`;
  const verb = effect === "irreversible" ? "Click (irreversible)" : "Click";
  return `${verb} ${target}`;
}
