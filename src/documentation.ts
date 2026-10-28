import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DOCUMENTATION_TOPICS = [
  { id: "overview", title: "Start here", file: "docs/product-guide.md" },
  { id: "conversations", title: "Conversations and reset", file: "docs/conversations.md" },
  { id: "cli", title: "CLI installation and usage", file: "docs/cli.md" },
  { id: "validation", title: "Validation and limits", file: "docs/cli-validation.md" },
  { id: "setup", title: "Models, browser and account setup", file: "README.md" },
  { id: "orchestration", title: "Multi-bot orchestration", file: "docs/bounded-orchestration.md" },
  { id: "coding", title: "Coding tools", file: "docs/coding-capability.md" },
  { id: "profiles", title: "Bot profiles and playbooks", file: "docs/agent-profiles.md" },
  { id: "architecture", title: "Architecture and release gates", file: "docs/pilo-architecture-audit.md" }
];
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
function inline(text: string): string {
  return escape(text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
      const decoded = href.replace(/&amp;/g, "&");
      if (/^https?:\/\//.test(decoded)) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      const topic = DOCUMENTATION_TOPICS.find(item => item.file === decoded || item.file === `docs/${decoded}` || item.file === decoded.replace(/^\.\.\//, ""));
      return topic ? `<a href="/docs?topic=${topic.id}">${label}</a>` : label;
    });
}
/** Escape all source HTML; render the Markdown subset used by the bundled guides. */
export function documentationMarkdown(source: string): string {
  let code: string[] | null = null, paragraph: string[] = [], table: string[][] = [];
  const output: string[] = [];
  const flushParagraph = () => { if (paragraph.length) output.push(`<p>${inline(paragraph.join(" "))}</p>`); paragraph = []; };
  const flushTable = () => {
    if (table.length) output.push(`<div class="table-scroll"><table><thead><tr>${table[0].map(cell => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${table.slice(1).filter(row => !row.every(cell => /^:?-+:?$/.test(cell))).map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    table = [];
  };
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith("```")) {
      flushParagraph(); flushTable();
      if (code) { output.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`); code = null; } else code = [];
    } else if (code) code.push(line);
    else if (/^\s*\|.*\|\s*$/.test(line)) { flushParagraph(); table.push(line.trim().slice(1, -1).split("|").map(cell => cell.trim())); }
    else {
      flushTable();
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) { flushParagraph(); output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
      else if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) { flushParagraph(); output.push(`<p class="list-item">${inline(line.trim())}</p>`); }
      else if (!line.trim()) flushParagraph();
      else paragraph.push(line.trim());
    }
  }
  flushParagraph(); flushTable(); if (code) output.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
  return output.join("\n");
}
export async function renderDocumentation(root: string, requested?: string | null): Promise<string> {
  const topic = DOCUMENTATION_TOPICS.find(item => item.id === requested) || DOCUMENTATION_TOPICS[0];
  const source = topic.id === "setup" ? await readFile(join(root, "docs/runtime-setup.md"), "utf8").catch(error => {
    if (error.code === "ENOENT") return readFile(join(root, topic.file), "utf8"); throw error;
  }) : await readFile(join(root, topic.file), "utf8");
  const body = documentationMarkdown(source);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(topic.title)} · Pilo Docs</title><style>
  *{box-sizing:border-box}body{margin:0;color:#20252d;background:#fafbfc;font:15px/1.7 system-ui,sans-serif}header{padding:18px 28px;border-bottom:1px solid #e1e5eb;background:white;display:flex;justify-content:space-between}header strong{letter-spacing:-.4px}a{color:#bb2038;text-decoration:none}a:hover{text-decoration:underline}.layout{max-width:1250px;margin:auto;display:grid;grid-template-columns:260px minmax(0,1fr);gap:42px;padding:32px 28px}nav{position:sticky;top:24px;align-self:start}nav a{display:block;padding:8px 12px;color:#424b58;border-radius:8px;font-size:14px}nav a[aria-current=page]{background:#fcecf0;color:#a31d34;font-weight:650}input{width:100%;padding:10px;border:1px solid #d7dde6;border-radius:8px;margin-bottom:12px;font:inherit}main{min-width:0;padding:0 16px 80px}h1{font-size:32px;line-height:1.2;letter-spacing:-1px;margin-top:0}h2{margin-top:38px;font-size:23px}h3{margin-top:28px}p{max-width:850px}pre{overflow:auto;padding:18px;background:#202632;color:#edf1f8;border-radius:10px;font-size:13px}code{font:13px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}p code,td code{background:#eef0f4;padding:2px 4px;border-radius:4px}.table-scroll{overflow:auto}table{border-collapse:collapse;min-width:100%;font-size:13px}th,td{padding:10px 12px;border-bottom:1px solid #dce1e8;text-align:left;vertical-align:top}th{background:#f0f3f7}.list-item{padding-left:12px}.eyebrow{font-size:11px;font-weight:650;letter-spacing:1.2px;color:#7a8491;margin:0 0 14px}@media(max-width:760px){.layout{display:block;padding:20px}nav{position:static;margin-bottom:28px}nav a{display:inline-block}main{padding:0 0 40px}h1{font-size:28px}}
  nav a[hidden]{display:none}</style></head><body><header><strong>Pilo <span style="color:#7a8491;font-weight:400">/ Documentation</span></strong><a href="/">Back to app</a></header><div class="layout"><nav aria-label="Documentation"><label for="docs-filter" class="eyebrow">GUIDES</label><input type="search" id="docs-filter" placeholder="Find a guide…">${DOCUMENTATION_TOPICS.map(item => `<a href="/docs?topic=${item.id}"${item.id === topic.id ? ' aria-current="page"' : ""}>${escape(item.title)}</a>`).join("")}</nav><main><p class="eyebrow">LOCAL OPERATOR GUIDE</p>${body}</main></div><script>document.getElementById('docs-filter').addEventListener('input',function(){var q=this.value.toLowerCase();document.querySelectorAll('nav a').forEach(function(link){link.hidden=!link.textContent.toLowerCase().includes(q)});});</script></body></html>`;
}
