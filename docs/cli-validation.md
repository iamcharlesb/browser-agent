# Pilo CLI 0.1.0-preview.1 validation

Validated locally on macOS on 2026-10-27 with isolated HTTP provider stubs, temporary
operator storage, disposable workspaces and headless Chromium. No real account
messages, purchases or publishing were performed.

## Interaction scenarios

| Scenario | Observed result |
| --- | --- |
| Initial campaign draft followed by a budget correction | Later provider input contains the original bakery goal and corrected $15 limit |
| Switch to another bot and return | Each bot receives its own conversation; private marker does not cross bots |
| Close the CLI and invoke it again | Same named bot resumes its saved context |
| Restart the packaged server | Goal and budget remain in the next provider input |
| Piped request attempts a file write | Approval is denied and no file is created |
| Separately approve a file write | Exactly one approval callback; expected file content is written |
| Piped request asks for publishing | Request fails before any model call |
| Interrupt one concurrent terminal request | The other bot remains active and completes |
| Abort while queued or between specialist turns | Only the owning job/discussion is cancelled |
| Repeated consultation, specialist failure or rejected delegation | Bounded discussion produces one final synthesis |
| Status and model-catalog inspection | No model calls |
| Browser UI with simultaneous conversations | Replies remain in the intended conversations; no page errors |
| Reopen the browser UI | Selected bot and separate drafts restore without submitting work |
| Reset from Settings, one bot then all bots | Transcripts, drafts and server context clear; role instructions remain |
| Reset an active bot with queued work | Its queued work is cancelled, writes settle, and the other bot keeps running |
| Submit old history after reset | Rejected before any model call |
| Clarify roles or point to the correct attachment | Optional delegation is disabled for that turn |
| Ask Local Engine about account analytics or SEO coordination | Explicit unsupported-task result; no unrelated web search |
| Open `/docs` | Bundled guides render without a model call or arbitrary file access |

## Checks

- `npm test`: 342 tests pass, zero failed/cancelled/skipped, including secret scan.
- `npm run cli:package`: isolated TypeScript production compilation and npm tarball creation.
- `node scripts/smokeCli.cjs`: fresh tarball installation, help/version, server start,
  documentation, chat, restart continuity, reset persistence and operator data
  outside the installed package pass.
- Tarball contains no environment files, private state, tests, source maps, local
  dependencies or Electron; a shrinkwrap pins the production dependency graph.

The baseline had two stale code-retrieval assertions that expected the parent
framework manifest after the workspace default had been narrowed to the browser
agent repository. Those assertions now verify the intended narrower scope.
The existing local fix to serve `uiState.js` and its browser-test fixtures is
included because the browser UI requires that asset.

## Limits

These checks validate runtime behavior and prompt/context delivery. Scripted
provider responses do not establish live model quality, cost or reliability.
The existing SDK/Zod peer conflict still requires `--legacy-peer-deps` for install.
The upfront task filter can request approval for negated publishing language.
Hosted account isolation, durable in-progress discussions and exactly-once
external actions remain outside the supported local single-operator preview.
