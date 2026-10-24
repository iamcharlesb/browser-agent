/** Evidence requirements for absence/access claims, independent of any site or task vocabulary. */
export interface ViewInspection {
  url: string; stateHash: string; scope: string; scopeFound: boolean;
  optionCount: number; rowCount: number; examples: string[]; contexts: string[];
  emptyIndicator: string; accessDeniedIndicator: string; text: string;
}
export function isAbsenceClaim(text: string): boolean {
  return /\b(?:no (?:accessible |available |verified |matching )?(?:propert(?:y|ies)|accounts?|records?|results?|data|items?|orders?|queries|query|keywords?|options?|entries|entry|reports?)|(?:there (?:are|is)|selector (?:is|was)|list (?:is|was)|picker (?:is|was)).{0,35}\bempty|(?:cannot|can['’]?t|unable to|not able to|could(?:n['’]?t| not)) (?:find|access|see|locate)|(?:owner|admin).{0,40}(?:grant|give).{0,20}access|(?:no|missing|without|do not have|don['’]?t have) (?:the )?(?:permission|access))\b/i.test(text) || /\bthere (?:are|is) (?:no|not any)\b/i.test(text);
}
export function findingEvidenceIssue(summary: string, current: {url:string;stateHash:string;accessDenied?:boolean}|null, evidence?: ViewInspection): string | null {
  if(!isAbsenceClaim(summary)||current?.accessDenied)return null;
  if(!current||!evidence||evidence.url!==current.url||evidence.stateHash!==current.stateHash) {
    return 'An unavailable/empty/access conclusion needs fresh evidence from the intended tab and current scope. List the open tabs, switch to the requested view, open the relevant selector/filter if needed, and call inspect_view. Prior replies and old runbooks are not current evidence.';
  }
  if(!evidence.scopeFound)return 'The inspected selector did not match a region. A missing selector is not an empty dataset. Inspect the current DOM/marks and the correct view.';
  if(evidence.accessDeniedIndicator)return null;
  if(evidence.emptyIndicator && evidence.scope!=="current page" && !/^(?:body|html)$/i.test(evidence.scope.trim()) && evidence.rowCount===0 && evidence.optionCount===0 && /\b(?:current|selected|visible|this)\b.{0,30}\b(?:view|filter|range|report|scope|page|table|list)\b/i.test(summary))return null;
  return `The current inspection does not establish unavailability (rows: ${evidence.rowCount}, choices: ${evidence.optionCount}; examples: ${evidence.examples.slice(0,4).join(' | ') || 'none extracted'}). Read the matching record/report, inspect a more precise region or change approach. If you still cannot verify it, report what you actually observed in the current view without claiming the resource/account has no data or access.`;
}
