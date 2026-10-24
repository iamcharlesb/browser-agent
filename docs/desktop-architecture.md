# Desktop workspace architecture

The product is an agent workspace with chat, terminal output, and Chrome-backed
browsing. Normal installed Chrome owns website sessions; the app displays its live
page through CDP. The UI and agent server are clients with shorter lifetimes.
Desktop-owned native Electron tabs remain an advanced option. A VS Code fork is not part of this implementation: the current product
does not need VS Code's editor, extension host, or workbench contribution system.

```text
Electron desktop process
  ├─ BrowserWorkspace: persistent session + one WebContentsView per tab
  │    ├─ native page rendering, focus, keyboard, scrolling, history
  │    ├─ tab selection, creation, closure, navigation events
  │    └─ private authenticated loopback browser broker
  ├─ workspace UI renderer
  │    ├─ chat + terminal panel + browser toolbar
  │    └─ restricted preload IPC: state, commands, bounds, visibility
  └─ agent server process (Node; watched independently in development)
       ├─ chat events, tools, approval policy, existing terminal tools
       ├─ desktopBrowser adapter → broker for tab state and commands
       └─ Playwright/CDP → selected native browser tab for automation
```

## Ownership and reload behavior

| Component | Owner | UI refresh | Agent server restart |
| --- | --- | --- | --- |
| Native tabs, history, in-page state | Electron BrowserWorkspace | Preserved | Preserved |
| Browser cookies/storage | Electron persist:open-bots partition | Preserved | Preserved |
| UI DOM | Workspace renderer | Recreated | Reloaded by dev event feed |
| Agent run and pending approvals | Agent server | Reattach using existing events | Reset |
| Agent CDP attachment | Agent server | Preserved | Reattached on next browser operation |

The regular-browser version retains the existing SSE preview and HTTP input
transport. It cannot embed arbitrary websites as native tabs inside another web
page. The desktop workspace is available through `npm run desktop:dev` and
`npm run desktop`; Chrome-backed browsing is its default.

## Desktop implementation

- `electron/browserWorkspace.js`: native tabs, popup routing, safe navigation,
  independent view visibility, and private loopback broker.
- `electron/main.js`: process lifecycle, workspace-only IPC authorization, browser
  host creation, agent-server startup, and reload isolation.
- `electron/preload.js`: a bounded API; no generic IPC, Node, or shell access in UI.
- `src/desktopBrowser.ts`: server-side broker adapter. The broker requires a random
  bearer token passed only to the child server and rejects browser Origin headers.
- `src/browserController.ts`: the agent matches the broker's selected tab ID to a
  CDP target ID. It does not select the first arbitrary page or the chat UI.

The UI receives native URL/title/loading/tab events. Human toolbar commands travel
through desktop IPC. Native clicks, typing, and scrolling go straight to the page.
The agent uses the same tabs; new-tab/switch-tab/close-tab commands go through the
workspace host. Embedded mode does not start a JPEG screencast. The agent can still
request screenshots as observations.

The native surface is hidden while a workspace modal is open and while the UI is
reloading, then docked back into its reported bounds. Hiding a tab or reloading the
workspace UI does not destroy its webContents.

## Development

From the repository root:

```sh
npm run desktop:dev
```

The launcher starts a TypeScript watcher and Electron. Electron owns the watched
Node agent process and advertises the browser broker/CDP configuration to it.
HTML/CSS/browser JS changes refresh the workspace page. Backend TypeScript changes
restart the Node child and refresh the page. Neither action recreates native tabs.
Electron main/preload/host changes still require restarting the desktop process.

Session state is preserved while the desktop is running; reopening the whole app
currently starts with a blank tab. This is not a full IDE or VS Code fork, and it
does not add an editor, extension compatibility, or a new interactive PTY terminal.
Google and other providers still control which browsers may sign in; changing the
application shell cannot guarantee OAuth acceptance.

## References

- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [VS Code workbench extension model](https://code.visualstudio.com/api/extension-capabilities/extending-workbench)

## Verification

`npm test` covers existing agent behavior plus native tab ownership, bounds, safe
navigation, and browser lifecycle unit tests. `npm run test:desktop` launches an
isolated Electron instance, temporary browser profile, and local fixture site. It
checks unsaved page state across UI refresh and a real backend watcher restart,
agent attachment/tab switching, and popup opener preservation. It requires desktop
access and local loopback ports; no model credentials or external test site are
needed. The temporary server modules are isolated from the working build.

## Website compatibility: Chrome-backed browsing

Desktop browsing now defaults to a normal installed Google Chrome process with the
app's dedicated `~/.buddy-bot-chrome-cdp` profile. The server starts it automatically
when needed, reuses it across server/app restarts, and connects through local CDP.
The existing live frame/input transport renders that same page inside the workspace.
Cookies stay in the dedicated profile; personal Chrome data is never copied.

This replaces embedded Electron as the default for actual website navigation:
Medium was verified to reject the embedded renderer while loading successfully in
the normal Chrome session. Native Electron tabs remain an advanced option. Set
`BROWSER_AGENT_MANAGED_CHROME=0` to disable automatic Chrome startup, or
`BROWSER_AGENT_CHROME_PATH` to select an installed Chrome executable.

The Chrome-backed pane is a streamed live view, not a native embedded Chrome window;
the dedicated Chrome window also exists for attended login. Its process stays open
when the app or agent server closes, keeping the browser session available. Closing
that dedicated window is safe; the app launches it again on the next new session.
Browser/agent run approval rules are unchanged.

Electron was upgraded to 45.0.0 for the desktop shell. Native tab selection now uses
CDP target IDs on the private broker; internal bot/tab markers are no longer added
to user-agent strings sent to websites.

## Full-window and responsive browser layout

The browser pane reports its CSS size after resizing, splitting, or expanding. A
bounded, debounced resize input changes Chrome's actual page viewport and restarts
the screencast with matching limits. Pages reflow to the pane, instead of scaling a
fixed 1280×800 picture into a tall area. The input coordinate mapping receives the
updated dimensions. Resize preserves page state and clears obsolete element marks.

The expand button hides chat and navigation to use the full window width while
keeping the app header and URL bar. Escape restores the split. On macOS the desktop
uses an inset native title bar and a draggable unified app header; new windows
maximize to the available screen area. Native tabs are hidden with view visibility,
retaining nonzero webpage bounds for agent observations while chat is open.

The message composer uses a full-width text row above a fixed-width toolbar. Its height
is bounded for long drafts, and the welcome area retains spare space so typing does not
move the input. The selected bot is restored after renderer reloads.

Each run carries the selected browser mode to the server. Before starting it, the server
releases any controller from a different mode. Run events are routed to the requesting
conversation even when another bot is selected; queued requests retain their bot owner.

Rich editors expose individual editable title/body blocks as marks. Text fields are filled
through their DOM locator, while coordinate typing remains available for other targets.
Model keyboard aliases (such as `END`) are normalized before Playwright dispatch.
Responses tool batches are processed in full so every function call receives an output.
The output allowance accommodates complete article text inside tool arguments.
