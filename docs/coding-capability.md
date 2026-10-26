# Reusable coding capability

The built-in `code_project` tool and `coding-workflow` playbook add grounded repository work to both agent engines. The model still determines reasoning quality; this feature does not claim Codex parity. No new model, embedding provider, autonomous job or watcher is required.

## Use it

Open the app's composer **+ → Index local coding workspace**. This explicitly builds or refreshes the index without a model request or running project commands. Then ask a bot to implement or debug something, for example:

> Inspect this repository's authentication flow, fix the failing behavior, and run the relevant tests. Use the reusable code index and preserve unrelated edits.

The index is also available directly to bots:

- `code_project(action="index", root="node/browser_agent")`: refresh a source subfolder relative to the app's existing workspace. Changed/new files are reindexed; deleted files disappear; unchanged file chunks are reused.
- `code_project(action="map", root="node/browser_agent", path="src")`: paginated file/declaration/import overview. Declarations/imports are lightweight lexical heuristics, not a full compiler symbol or call graph.
- `code_project(action="search", root="node/browser_agent", query="requiresPrivilegedApproval")`: ranked, bounded excerpts with exact source lines and a revision. Matching declarations receive a ranking boost. Follow `nextOffset` for more.
- `code_project(action="read", root="node/browser_agent", path="src/promptLoop.ts", line=130)`: current live source, paged by line, with a hash for guarded editing. An unusually long line may be explicitly marked as a truncated excerpt; use the existing filesystem/terminal tools when a complete long-line inspection is necessary.
- `workspace_file(action="patch", path="node/browser_agent/src/promptLoop.ts", expectedHash="...", oldText="unique exact old text", newText="replacement")`: subject to the existing workspace edit approval gate. Path is workspace-relative, unlike the index's root-relative read paths. Stale hashes and ambiguous matches fail without editing. This is an optimistic check, not a transaction against an external editor changing the file during the final write.
- `run_terminal_command`: use the existing command and approval controls for relevant tests, builds and diff review. Index refresh never executes project code, installs packages or runs tests on its own.

`status`, `map`, and `search` reuse the on-disk index. They are snapshots at `indexedAt`; refresh explicitly at task start and after edits. `read` always checks live source. Defaults index up to 5,000 source files / 32 MB, with at most 1 MB per file, 12,000 chunks, and bounded retrieval output. Code results have a separate `BROWSER_AGENT_CODE_TOOL_RESULT_CHARS` budget (16,000 characters by default) in the token-lean engine so the generic short-result cap does not remove source-page metadata. Limits and the cache directory are environment settings in `.env.example`. Oversized projects fail with guidance to narrow the root; chunk truncation is reported explicitly.

## Selected project folders

**+ → Select project folder** builds a persistent index alongside the imported read-only source snapshot. Existing snapshots are upgraded on their next read. The bot retains the project's reference through its knowledge store and can reuse it across turns and server restarts:

- `knowledge_base(action="map", id="project:UUID")`
- `knowledge_base(action="retrieve", id="project:UUID", query="authentication session")`
- Existing literal `search`, exact-file `read`, and path `list` remain available.

Selecting a folder does not bind its original filesystem location to editing or terminal execution. To refresh an imported snapshot, select it again. External projects need an explicitly configured local workspace before live edits; the imported source remains read-only.

## Scope and implementation

Git repositories use tracked files and untracked files allowed by standard Git exclusion rules; existing submodules receive their own listing. Tracked files remain eligible even if a later Git ignore pattern matches them, as with Git itself. Outside Git, a bounded directory walk uses the built-in exclusions rather than claiming to implement all `.gitignore` semantics.

Downloaded dependencies (`node_modules`, `vendor`, virtual environments, package caches), generated output, lockfiles, binaries, common credential files and external symlink targets are excluded from indexing. Private runtime index data lives in the ignored `.browser-agent-code-index/` directory, with cache files written at mode 0600. Source excerpts are redacted before persistent indexing. This reduces exposure; it is not a guarantee that an arbitrary secret embedded in source can always be recognized. Source text, comments and retrieved instructions cannot grant new runtime permissions.

Retrieval uses overlapping line chunks, identifier/camel-case tokenization, BM25-style length-normalized term ranking, phrase and declaration boosts, and excerpts centered on matching lines. This is inexpensive lexical retrieval; it cannot infer arbitrary semantic equivalents. Detailed context stays out of the system prompt until requested. Model-based semantic search and compiler-grade dependency analysis are possible future additions, not implemented capabilities.

Primary references: [Git file enumeration](https://git-scm.com/docs/git-ls-files), [Robertson and Zaragoza, The Probabilistic Relevance Framework: BM25 and Beyond](https://doi.org/10.1561/1500000019).
