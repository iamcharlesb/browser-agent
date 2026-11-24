# Pilo CLI preview

The CLI runs the same local runtime as the desktop app, with terminal conversations,
specialist profiles, scoped approval prompts, and per-bot context. Node.js 22 or newer
is required for this preview. Electron is not installed.

## Install and start

Download the release tarball and install it:

```sh
npm install --global --legacy-peer-deps ./iamcharlesb-pilo-cli-0.1.0-preview.1.tgz
pilo --version
pilo serve --env-file /absolute/path/to/your/.env --workspace /path/to/project
```

`--legacy-peer-deps` is currently necessary because the existing runtime has an
OpenAI SDK/Zod peer conflict. Runtime dependencies are pinned to the versions in
the repository lockfile, including a shrinkwrap for transitive versions. This
preview has not resolved that compatibility debt.

The package is `@iamcharlesb/pilo-cli` and the command is `pilo`. New installs use
`~/.pilo`. An existing legacy data directory is reused when `~/.pilo` does not
yet exist, preserving saved conversations. Set `--data-dir` to choose explicitly.

The server binds to loopback, defaults to port 8765, and stays in the foreground.
It does not open a browser window or enable self-fixing learn mode. Private state
lives in the selected data directory, independently of the installed package. Override with
`--data-dir` or `BROWSER_AGENT_DATA_DIR`. Coding tools use the explicit workspace
or the directory where `serve` was started.

Credentials, provider model versions, prices and operating limits belong in the
server environment or the explicitly selected environment file. Shell environment
values take precedence. The CLI does not accept provider keys as command arguments.
Without `--env-file`, it reads `.env` from the selected data directory.
Without a configured model, Local Engine is a limited deterministic fallback, not
a general language model.

In another terminal:

```sh
pilo models
pilo chat --bot "Marketing" --profile chief-marketing-officer
pilo ask --bot "Marketing" --task "Revise the previous draft for a smaller budget"
pilo ask --task "Summarize the current plan" --json
```

Use `--server http://127.0.0.1:8766` to connect to an already running production or
desktop server. Starting `serve` is optional when an existing server is available.

## Conversations and approval

`chat` accepts one request per line. `/bot NAME` switches conversations, `/model ID`
changes the selected configured model, and `/quit` exits. The bot name identifies
its server-side memory; using the same name resumes that bot, including after a
server restart. A different name has separate context. CLI and UI conversations
share state when they use the same server and bot name. There is no CLI roster sync.

Chat mode is the default. `--mode browse` enables browser reading and `--mode act`
enables the runtime's browser actions with its existing policy gates. Install
Playwright Chromium separately if needed (`npx playwright install chromium`, from
the source checkout). Text-only chat does not require a browser installation.
Human verification requires the local UI; the CLI stops its request if that pause
occurs, rather than pretending verification is complete.

Interactive approvals accept only `y` or `yes` and apply once. Piped/JSON requests
deny privileged tool approvals; task requests requiring upfront approval fail with
an error. No CLI option grants standing approval. Ctrl-C and the configured
`BROWSER_AGENT_CLI_TIMEOUT_SECONDS` deadline cancel only this client's request or
discussion, including a queued job. The default deadline is 1800 seconds. A network
failure does not retry the task automatically; inspect state before submitting
again because the server may already have accepted it.

Exit codes: 0 = successful result, 1 = completed unsuccessful task, 2 = input or
transport error, 130 = interrupted. `--json` emits the terminal result to stdout;
diagnostics stay on stderr.

The existing upfront task filter is conservative: even a negated phrase such as
"do not publish" can request approval. Runtime action gates still apply independently.

## Build a local release

```sh
npm run cli:package
```

The packaging script builds an isolated production copy, stages an explicit asset
allowlist, and creates an installable npm tarball and SHA-256 checksum in
`release/`. It excludes environment files, private state, browser profiles, source
maps, tests, Electron, and local dependencies. Dependencies install normally from
the package's pinned production dependency list. No registry publication happens
as part of this command.

This is a local single-operator preview. Deterministic provider-stub checks validate
runtime behavior; they do not measure live model quality or certify hosted use.

## License and attribution

This preview uses the bundled Pilo Attribution License 1.0, which permits
personal, noncommercial, commercial, and enterprise use subject to its conditions.
Redistributions and public uses must preserve the persistent author credit and
LinkedIn/X links specified in LICENSE and NOTICE. This is a custom license;
do not describe it as MIT-licensed or OSI-approved open source.
