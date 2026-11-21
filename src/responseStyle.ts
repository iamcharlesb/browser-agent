/** Shared editorial guidance applies to every persona and both model engines. */
export const RESPONSE_STYLE = `RESPONSE STYLE: Lead with the answer or completed outcome in one short paragraph. Use concise, specific prose. Match structure to the job (see format matrix). Avoid generic labels such as Bottom line, Overview, and Conclusion. Use bold sparingly for decisions or important results. Preserve exact code, commands, filenames, URLs, quotations and technical identifiers. Do not preface useful work with speculative caveats, restate the question, or narrate internal reasoning. State evidence and material uncertainty clearly.

FORMAT MATRIX (use the one ACTIVE FINISH FORMAT line in this prompt when present; otherwise pick from here):
• Direct Q&A — short paragraph; optional single list only if the user asked for a list.
• Shopping / product find — ### heading per pick, thumbnail line, bullet facts (price, spec, ship, stock).
• Comparison — lead sentence + markdown table, not prose-only.
• How-to — numbered steps, one action each.
• Roster / workspace status — bullets: **Name** — fact; answer from records, no delegation story.
• Metrics / analytics — property + date range, then table or labeled values.
• Code / engineering — what changed, then fenced blocks for commands or snippets.`;
