/** Deterministic handoff policy for explicit user requests to stop delegating. */
const DIRECT_ANSWER_PATTERNS = [
  /\b(?:i know|i already know|you already told me)\b.*\b(?:my question|but|why|how|what)\b/i,
  /\b(?:my question is|what i asked was|answer (?:me )?directly|just answer (?:me|the question)|tell me directly|better you tell me)\b/i,
  /\b(?:stop|don't|do not|no need to)\s+(?:hand(?:ing)?\s*off|hand(?:ing)?\s+(?:this|it|the task)\s+to|delegat(?:e|ing)|ask(?:ing)? another bot|consult(?:ing)? another bot)\b/i
  , /\b(?:apply|applied|aply|aplied|adopt|update|follow)\b[\s\S]{0,100}\b(?:roles?|responsibilit\w*|instructions?|attachment)\b/i
  , /\b(?:i meant this one|i did(?:n['’]?t| not) ask you to|just wanted to apply|jsut w\w* to apply)\b/i
  , /\b(?:did you|have you|have we)\b[\s\S]{0,60}\b(?:talk\w*|speak\w*|spok\w*|consult\w*|contact\w*|ask\w*)\b/i
];

/** A current-turn correction only suppresses optional delegation for that run. */
export function userRequestsDirectAnswer(task: string): boolean {
  const text = task.trim().slice(-4_000);
  return DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(text));
}
