/** Persistent code index for the existing local workspace; selected uploads remain snapshots. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, realpath, lstat, rename, writeFile } from 'node:fs/promises';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildCodeIndex, CodeIndex, CodeSource, queryCodeIndex, sourceHash } from './codeIndex';
import { normalizeProjectPath, projectPathAllowed, projectImportConfig, PROJECT_IGNORED_DIRS } from './projectAttachments';
import { envInteger } from './runtimeConfig';
import { redactSecrets } from './security';
const exec = promisify(execFile);
function limits() {
  return { ...projectImportConfig(), maxFiles: envInteger('BROWSER_AGENT_CODE_MAX_FILES', 5000, 1, 20000),
    maxFileBytes: envInteger('BROWSER_AGENT_CODE_MAX_FILE_BYTES', 1000000, 1000, 4000000),
    maxProjectBytes: envInteger('BROWSER_AGENT_CODE_MAX_BYTES', 32000000, 1000, 128000000) };
}
const refreshes = new Map<string, Promise<CodeIndex>>();
const generated = new Set([...PROJECT_IGNORED_DIRS, '.test-dist', 'artifacts', 'downloads', 'logs', '.turbo', '.svelte-kit', '.parcel-cache', 'bower_components', 'target', 'site-packages', '.codex', '.agents', '.config', '.local']);
function allowed(path: string) {
  return !path.split('/').some(part => generated.has(part.toLowerCase()) || part.startsWith('.browser-agent-')) &&
    !/(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path) && !/\.(?:min\.[cm]?js|map)$/.test(path) && projectPathAllowed(path);
}
async function inside(root: string, path: string) {
  const target = await realpath(resolve(root, path));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Code paths must stay within the workspace.');
  return target;
}
async function enumerate(root: string): Promise<{paths: string[]; gitAware: boolean}> {
  try {
    const config = limits();
    const exclusions = [...generated].map(name => `:(exclude,glob,icase)**/${name}/**`);
    const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.', ...exclusions], {
      cwd: root, encoding: 'utf8', timeout: envInteger('BROWSER_AGENT_CODE_GIT_TIMEOUT_MS', 10000, 100, 60000), maxBuffer: config.maxProjectBytes
    });
    const paths = new Set<string>();
    for (const raw of stdout.split('\0').filter(Boolean)) {
      const path = normalizeProjectPath(raw);
      if (path.split('/').some(part => generated.has(part.toLowerCase()) || part.startsWith('.browser-agent-'))) continue;
      const info = await lstat(join(root, path)).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        // Gitlinks need their own listing; the parent index contains only the directory name.
        const nested = await enumerate(join(root, path));
        nested.paths.forEach(child => paths.add(path + '/' + child));
      } else if (allowed(path)) paths.add(path);
    }
    return { paths: [...paths].sort(), gitAware: true };
  } catch (error) {
    // A working Git repository must not silently become an unfiltered scan on timeout/failure.
    try { await exec('git', ['rev-parse', '--is-inside-work-tree'], {cwd: root, timeout: 1000}); }
    catch { return { paths: await walk(root), gitAware: false }; }
    throw new Error('Git source listing failed; narrow the index root or check Git before retrying.');
  }
}
async function walk(root: string, prefix = '', output: string[] = []): Promise<string[]> {
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink() || generated.has(entry.name.toLowerCase()) || entry.name.startsWith('.browser-agent-')) continue;
    if (entry.isDirectory()) { if (!entry.name.startsWith('.') || entry.name === '.github') await walk(root, path, output); }
    else if (entry.isFile() && allowed(path)) output.push(path);
    if (output.length > limits().maxFiles) throw new Error('Project has too many source files; index a smaller root.');
  }
  return output;
}
interface StoredIndex { root: string; indexedAt: string; gitAware: boolean; excludedFiles: number; index: CodeIndex }
export async function workspaceCode(input: Record<string, unknown>, workspace: string, cacheDirectory: string): Promise<unknown> {
  const base = await realpath(workspace);
  const rootArg = String(input.root || '.');
  if (isAbsolute(rootArg)) throw new Error('Use a root relative to the workspace.');
  const root = await inside(base, rootArg);
  const scope = relative(base, root).split(sep);
  if (scope.some(part => generated.has(part.toLowerCase()) || part.startsWith('.browser-agent-'))) throw new Error('Choose a source project directory, not a dependency, generated or private directory.');
  if (!(await lstat(root)).isDirectory()) throw new Error('Code root must be a directory.');
  const key = sourceHash(root), filename = join(cacheDirectory, key + '.json');
  let stored: StoredIndex | undefined;
  try { stored = JSON.parse(await readFile(filename, 'utf8')); if (stored?.root !== root || stored.index?.version !== 1 || !Array.isArray(stored.index.files)) stored = undefined; } catch { /* Build a missing or damaged cache on demand. */ }
  const action = String(input.action || 'search');
  if (!['index','status','map','search','read'].includes(action)) throw new Error('Code tools support index, status, map, search and read.');
  if (action === 'read') {
    const path = normalizeProjectPath(input.path);
    if (!allowed(path)) throw new Error('This path is excluded from source retrieval.');
    const target = await inside(root, path), info = await lstat(target);
    if (!info.isFile() || info.size > limits().maxFileBytes) throw new Error('Choose a regular source file within the file size limit.');
    const raw = await readFile(target, 'utf8');
    if (raw.includes('\0')) throw new Error('Binary files are excluded.');
    const text = redactSecrets(raw), lines = text.split('\n');
    const start = input.line === undefined ? 1 : Number(input.line);
    if (!Number.isSafeInteger(start) || start < 1) throw new Error('Use a positive starting line.');
    const maxChars = envInteger('BROWSER_AGENT_CODE_RESULT_CHARS', 6000, 500, 20000);
    const page = lines.slice(start - 1, start - 1 + envInteger('BROWSER_AGENT_CODE_READ_LINES', 100, 1, 500));
    while (page.length > 1 && page.join('\n').length > maxChars) page.pop();
    const content = page.join('\n').slice(0, maxChars);
    return { path, hash: sourceHash(raw), live: true, startLine: start, endLine: start + page.length - 1,
      excerptTruncated: content.length < page.join('\n').length, totalLines: lines.length,
      nextLine: start + page.length <= lines.length ? start + page.length : null, text: content };
  }
  if (!stored || action === 'index') {
    let pending = refreshes.get(filename);
    if (!pending) {
      pending = (async () => {
        const listing = await enumerate(root), bounds = limits();
        if (listing.paths.length > bounds.maxFiles) throw new Error('Project has too many source files; index a smaller root.');
        const sources: CodeSource[] = [];
        let bytes = 0, excludedFiles = 0;
        for (const path of listing.paths) {
          const target = await inside(root, path), info = await lstat(target);
          if (!info.isFile() || info.size > bounds.maxFileBytes) { excludedFiles++; continue; }
          const text = await readFile(target, 'utf8');
          if (text.includes('\0')) { excludedFiles++; continue; }
          bytes += Buffer.byteLength(text);
          if (bytes > bounds.maxProjectBytes) throw new Error('Project exceeds index size limit; index a smaller root.');
          sources.push({path, text});
        }
        const index = buildCodeIndex(sources, stored?.index);
        const next: StoredIndex = {root, indexedAt: new Date().toISOString(), gitAware: listing.gitAware, excludedFiles, index};
        await mkdir(cacheDirectory, { recursive: true });
        const temporary = filename + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, JSON.stringify(next), {mode: 0o600});
        await rename(temporary, filename);
        stored = next;
        return index;
      })();
      refreshes.set(filename, pending);
    }
    try { await pending; } finally { if (refreshes.get(filename) === pending) refreshes.delete(filename); }
    stored = JSON.parse(await readFile(filename, 'utf8')) as StoredIndex;
  }
  if (!stored) throw new Error('Code index unavailable.');
  if (action === 'index' || action === 'status') return { root: rootArg, indexedAt: stored.indexedAt, gitAware: stored.gitAware, totalFiles: stored.index.files.length,
    revision: stored.index.revision, reusedFiles: stored.index.reusedFiles, truncated: stored.index.truncated, excludedFiles: stored.excludedFiles,
    note: 'Local reusable index. Run index to refresh after edits; read returns live source. No source edits, model calls or user commands were executed.' };
  const path = input.path ? normalizeProjectPath(input.path) : '';
  return { ...queryCodeIndex(stored.index, {...input, path}), indexedAt: stored.indexedAt, freshness: 'Snapshot at indexedAt; refresh with index after edits.' };
}

/** Optimistic, exact replacement for existing source files; never replaces an entire stale document. */
export async function guardedCodePatch(workspace: string, path: string, expectedHash: string, oldText: string, newText: string) {
  const root = await realpath(workspace), normalized = normalizeProjectPath(path);
  if (!allowed(normalized)) throw new Error('This path is excluded from code patches.');
  const target = await inside(root, normalized), info = await lstat(target);
  if (!info.isFile() || info.size > limits().maxFileBytes) throw new Error('Choose a regular source file within the file size limit.');
  const raw = await readFile(target, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || sourceHash(raw) !== expectedHash) throw new Error('Source changed; read it again and prepare a new patch.');
  if (!oldText || raw.indexOf(oldText) === -1 || raw.indexOf(oldText) !== raw.lastIndexOf(oldText)) throw new Error('Patch must match exactly one source occurrence.');
  const next = raw.replace(oldText, () => newText);
  if (Buffer.byteLength(next) > limits().maxFileBytes) throw new Error('Patch exceeds the source file limit.');
  // Final check reduces accidental clobbering; this is not a filesystem transaction against external editors.
  if (sourceHash(await readFile(target, 'utf8')) !== expectedHash) throw new Error('Source changed while patching; read again.');
  await writeFile(target, next, 'utf8');
  return { path: normalized, beforeHash: expectedHash, hash: sourceHash(next), changed: next !== raw, note: 'Patch applied. Inspect the diff and run relevant tests; refresh the code index before further searches.' };
}
