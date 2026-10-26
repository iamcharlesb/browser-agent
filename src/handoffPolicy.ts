/** Deterministic handoff policy for explicit user requests to stop delegating. */
const DIRECT_ANSWER_PATTERNS = [
  /\b(?:i know|i already know|you already told me)\b.*\b(?:my question|but|why|how|what)\b/i,
  /\b(?:my question is|what i asked was|answer (?:me )?directly|just answer (?:me|the question)|tell me directly|better you tell me)\b/i,
  /\b(?:stop|don't|do not|no need to)\s+(?:hand(?:ing)?\s*off|hand(?:ing)?\s+(?:this|it|the task)\s+to|delegat(?:e|ing)|ask(?:ing)? another bot|consult(?:ing)? another bot)\b/i
];

/** A current-turn correction only suppresses optional delegation for that run. */
export function userRequestsDirectAnswer(task: string): boolean {
  const text = task.trim().slice(-4_000);
  return DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(text));
}
