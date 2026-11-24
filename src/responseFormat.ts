import { enrichShoppingSummary, looksLikeShoppingSummary } from "./shoppingReply";

export type ResponseFormat =
  | "default"
  | "shopping"
  | "comparison"
  | "steps"
  | "roster"
  | "metrics"
  | "code";

const FORMAT_SIGNALS: Array<{ format: ResponseFormat; pattern: RegExp }> = [
  {
    format: "comparison",
    pattern:
      /\b(?:compare|comparison|versus|\bvs\.?\b|side by side|pros and cons|which (?:is|one) better|top\s+\d+\s+(?:options|picks|competitors))\b/i
  },
  {
    format: "shopping",
    pattern:
      /\b(?:ship(?:ped|ping)?\s+to|add to cart|in stock|buy online|find .{0,40}online|nursery|shrub|tree|flower|hibiscus|plant|dogwood|\d+\s*(?:to|-)\s*\d+\s*ft|\d{5}(?:-\d{4})?)\b/i
  },
  {
    format: "roster",
    pattern:
      /\b(?:all (?:the )?bots|goals from|workspace roster|which bot|get the goals|plan for .{0,30}bot|how many subreddit|assigned to)\b/i
  },
  {
    format: "steps",
    pattern: /\b(?:how to|step by step|walk me through|checklist|set up .{0,40}for me)\b/i
  },
  {
    format: "metrics",
    pattern:
      /\b(?:gsc|search console|ga4|analytics|impressions|clicks|ctr|conversion rate|performance report|queries report)\b/i
  },
  {
    format: "code",
    pattern:
      /\b(?:patch|refactor|implement|workspace_file|npm test|typescript|fix (?:the )?(?:bug|error)|pull request)\b/i
  }
];

/** Pick the deliverable shape from the user's ask (and saved context snippet). */
export function inferResponseFormat(taskAndContext: string): ResponseFormat {
  const text = taskAndContext.trim();
  if (!text) return "default";
  for (const { format, pattern } of FORMAT_SIGNALS) {
    if (pattern.test(text)) return format;
  }
  return "default";
}

export function inferResponseFormatForFinish(task: string, summary: string): ResponseFormat {
  const fromTask = inferResponseFormat(task);
  if (fromTask !== "default") return fromTask;
  if (looksLikeShoppingSummary(summary)) return "shopping";
  if (/\|.+\|.+\|/.test(summary) && /\n\|[-:\s|]+\|\n/.test(summary)) return "comparison";
  if (/^\s*\d+[.)]\s+/m.test(summary) && /\b(?:step|first|then|finally)\b/i.test(summary)) return "steps";
  return "default";
}

export function formatInstructionFor(format: ResponseFormat): string {
  switch (format) {
    case "shopping":
      return (
        "ACTIVE FINISH FORMAT — shopping: One opening sentence with the best verified match. " +
        "Then up to 3 picks, each as ### [Product name](productUrl), next line [![Product name](imageUrl)](productUrl) " +
        "(real og:image from the page you verified), then bullet facts: Price, Size/spec, Shipping to user's ZIP, Stock. " +
        "Apply every user clarification as a hard filter."
      );
    case "comparison":
      return (
        "ACTIVE FINISH FORMAT — comparison: One sentence recommendation, then a markdown table " +
        "| Option | Price or key metric | Best for | Link | with verified cells only."
      );
    case "steps":
      return "ACTIVE FINISH FORMAT — how-to: Short intro, then a numbered list of steps (one action per step).";
    case "roster":
      return (
        "ACTIVE FINISH FORMAT — roster/status: Bullet list, one line per bot or item: **Name** — goal, status, or answer; " +
        "no handoff narration."
      );
    case "metrics":
      return (
        "ACTIVE FINISH FORMAT — metrics: State property and date range first. " +
        "Use a table when comparing metrics; otherwise labeled lines (Metric: value). Flag missing data."
      );
    case "code":
      return (
        "ACTIVE FINISH FORMAT — code: What changed and why in one paragraph, then fenced code blocks for commands or diffs."
      );
    default:
      return (
        "ACTIVE FINISH FORMAT — direct answer: One short lead paragraph with the outcome, then only the structure the ask needs " +
        "(list, table, or code), not a generic essay."
      );
  }
}

export async function enrichFinishSummary(
  summary: string,
  format: ResponseFormat,
  signal?: AbortSignal
): Promise<string> {
  if (format === "shopping") return enrichShoppingSummary(summary, signal);
  return summary;
}