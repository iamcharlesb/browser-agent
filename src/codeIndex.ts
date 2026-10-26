/** Bounded, offline source retrieval. No embeddings, provider calls, watchers or execution. */
import { createHash } from 'node:crypto';
import { envInteger } from './runtimeConfig';
import { redactSecrets } from './security';

export interface CodeSource { path: string; text: string }
export interface CodeChunk { path: string; startLine: number; endLine: number; text: string; terms: Record<string, number>; length: number }
export interface CodeFile { path: string; hash: string; lines: number; symbols: Array<{ name: string; line: number }>; imports: string[]; chunks: CodeChunk[] }
export interface CodeIndex { version: 1; revision: string; files: CodeFile[]; truncated: boolean; reusedFiles: number }
export const sourceHash = (text: string) => createHash('sha256').update(text).digest('hex');
export function codeIndexConfig() {
  return { chunkLines: envInteger('BROWSER_AGENT_CODE_CHUNK_LINES', 60, 10, 200),
    maxChunks: envInteger('BROWSER_AGENT_CODE_MAX_CHUNKS', 12000, 1, 50000),
    resultChars: envInteger('BROWSER_AGENT_CODE_RESULT_CHARS', 6000, 500, 20000),
    results: envInteger('BROWSER_AGENT_CODE_RESULTS', 6, 1, 20) };
}
function tokens(text: string): string[] {
  const expanded = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return expanded.match(/[a-z0-9]+/g)?.filter(term => term.length > 1).slice(0, 50000) || [];
}
function termCounts(text: string): Record<string, number> {
  const counts = Object.create(null);
  for (const word of tokens(text)) counts[word] = (counts[word] || 0) + 1;
  return counts;
}
export function buildCodeIndex(sources: CodeSource[], previous?: CodeIndex): CodeIndex {
  const config = codeIndexConfig();
  const previousFiles = new Map(previous?.version === 1 ? previous.files.map(file => [file.path, file]) : []);
  const files: CodeFile[] = [];
  let reusedFiles = 0, chunkCount = 0, truncated = false;
  for (const source of [...sources].sort((a,b) => a.path.localeCompare(b.path))) {
    const text = redactSecrets(source.text), hash = sourceHash(text + '\nchunkLines=' + config.chunkLines);
    const old = previousFiles.get(source.path);
    if (!previous?.truncated && old?.hash === hash && chunkCount + old.chunks.length <= config.maxChunks) {
      files.push(old); reusedFiles++; chunkCount += old.chunks.length; continue;
    }
    const lines = text.split('\n');
    const symbols: CodeFile['symbols'] = [], imports: string[] = [], chunks: CodeChunk[] = [];
    lines.forEach((line, index) => {
      // Lightweight declarations only; deliberately not advertised as a complete language parser.
      const match = /\b(?:function|class|interface|type|enum|def|struct|fn|func)\s+([A-Za-z_$][\w$]*)|\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
      if (match && symbols.length < 200) symbols.push({ name: match[1] || match[2], line: index + 1 });
      const dependency = /\bfrom\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/.exec(line);
      if (dependency && imports.length < 100) imports.push(dependency[1] || dependency[2] || dependency[3]);
    });
    for (let start = 0; start < lines.length; start += Math.max(1, config.chunkLines - 10)) {
      if (chunkCount >= config.maxChunks) { truncated = true; break; }
      const end = Math.min(lines.length, start + config.chunkLines);
      const content = lines.slice(start, end).join('\n');
      const terms = termCounts(source.path + '\n' + content);
      chunks.push({ path: source.path, startLine: start + 1, endLine: end, text: content, terms, length: Object.values(terms).reduce((a,b) => a + b, 0) });
      chunkCount++;
      if (end === lines.length) break;
    }
    files.push({ path: source.path, hash, lines: lines.length, symbols, imports: [...new Set(imports)], chunks });
  }
  return { version: 1, revision: sourceHash(JSON.stringify(files.map(f => [f.path, f.hash])) + JSON.stringify(config)).slice(0,16), files, reusedFiles, truncated };
}
export function queryCodeIndex(index: CodeIndex, input: Record<string, unknown>) {
  const config = codeIndexConfig(), action = String(input.action || 'search');
  const path = String(input.path || '');
  const scoped = index.files.filter(file => !path || file.path === path || file.path.startsWith(path + '/'));
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Use a non-negative result offset.');
  if (action === 'map' || action === 'status') {
    const files = scoped.slice(offset, offset + 20).map(file => ({ path: file.path, lines: file.lines, symbols: file.symbols.slice(0, 12), imports: file.imports.slice(0, 8) }));
    // Maps also have an output budget; pagination counts emitted files only.
    while (files.length && JSON.stringify(files).length > config.resultChars) files.pop();
    if (!files.length && scoped[offset]) files.push({ path: scoped[offset].path, lines: scoped[offset].lines, symbols: [], imports: [] });
    return { revision: index.revision, totalFiles: scoped.length, truncated: index.truncated, files,
      nextOffset: offset + files.length < scoped.length ? offset + files.length : null };
  }
  const query = String(input.query || '').trim();
  if (!query || query.length > 200) throw new Error('Provide a code query of 1–200 characters.');
  const terms = [...new Set(tokens(query))];
  if (!terms.length) throw new Error('Use a query containing an identifier or words.');
  const chunks = scoped.flatMap(file => file.chunks), count = chunks.length;
  const declarations = scoped.flatMap(file => file.symbols.filter(symbol => tokens(symbol.name).join(' ') === terms.join(' ')).map(symbol => ({path: file.path, line: symbol.line})));
  const average = chunks.reduce((sum, chunk) => sum + chunk.length, 0) / Math.max(count, 1);
  const df = new Map(terms.map(term => [term, chunks.filter(chunk => Object.hasOwn(chunk.terms, term)).length]));
  const ranked = chunks.map(chunk => {
    let score = 0;
    for (const term of terms) {
      const tf = Object.hasOwn(chunk.terms, term) ? chunk.terms[term] : 0;
      if (tf) score += Math.log(1 + (count - df.get(term)! + .5) / (df.get(term)! + .5)) * tf * 2.2 / (tf + 1.2 * (.25 + .75 * chunk.length / Math.max(average, 1)));
    }
    if (score && chunk.text.toLowerCase().includes(query.toLowerCase())) score += 2;
    if (score && declarations.some(symbol => symbol.path === chunk.path && symbol.line >= chunk.startLine && symbol.line <= chunk.endLine)) score += 8;
    return { chunk, score };
  }).filter(item => item.score > 0).sort((a,b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path) || a.chunk.startLine - b.chunk.startLine);
  const matches: Array<{path: string; startLine: number; endLine: number; score: number; text: string; excerptTruncated: boolean}> = [];
  let remaining = config.resultChars;
  for (const { chunk, score } of ranked.slice(offset, offset + config.results)) {
    const budget = Math.min(remaining - 250, Math.floor(config.resultChars / Math.min(config.results, Math.max(1, ranked.length))));
    if (budget <= 0) break;
    const lines = chunk.text.split('\n');
    let anchor = 0, best = -1;
    lines.forEach((line, i) => {
      const words = new Set(tokens(line));
      const relevance = terms.filter(term => words.has(term)).length + (line.toLowerCase().includes(query.toLowerCase()) ? 100 : 0) +
        (declarations.some(symbol => symbol.path === chunk.path && symbol.line === chunk.startLine + i) ? 200 : 0);
      if (relevance > best) { best = relevance; anchor = i; }
    });
    let start = Math.max(0, anchor - 3);
    while (start < anchor && lines.slice(start, anchor).join('\n').length > budget / 2) start++;
    const text = lines.slice(start).join('\n').slice(0, budget);
    const startLine = chunk.startLine + start;
    matches.push({ path: chunk.path, startLine, endLine: startLine + text.split('\n').length - 1, score: Number(score.toFixed(3)), text, excerptTruncated: start > 0 || text.length < chunk.text.length });
    remaining -= JSON.stringify(matches.at(-1)).length;
  }
  return { revision: index.revision, truncated: index.truncated, totalMatches: ranked.length, matches,
    nextOffset: offset + matches.length < ranked.length ? offset + matches.length : null,
    note: 'Ranked lexical retrieval, not semantic understanding. Inspect cited files and tests before editing.' };
}
