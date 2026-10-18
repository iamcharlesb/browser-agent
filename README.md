# Open Bots (Browser Agent)

## Run in development and production

Use two terminal windows from this directory:

```sh
npm run dev
```

The development server rebuilds and restarts as source files change. It uses port **8765** by default; open [http://127.0.0.1:8765](http://127.0.0.1:8765).

In a second terminal, run:

```sh
npm run built
```

This compiles an isolated production copy into `build/` and starts it at [http://127.0.0.1:8766](http://127.0.0.1:8766). Development stays on **8765** while production uses **8766**, so both servers can run at the same time. The `build/` output is ignored by Git.

Set `BROWSER_AGENT_UI_PORT` to override a server's default port. For example, `BROWSER_AGENT_UI_PORT=8770 npm run dev` or `BROWSER_AGENT_UI_PORT=8771 npm run built`.

## API contract (artifacts)

Typed helpers live in [`src/apiContract.ts`](src/apiContract.ts).

### `GET /api/artifacts/:filename`

Serves a file written by tools such as `generate_image` or `create_document`.

| | |
| --- | --- |
| Path | Filename is sanitized to `[A-Za-z0-9._-]`; missing files → `404` `{ "detail": "Artifact not found." }` |
| Query | `?download=1` (or `true`) forces `Content-Disposition: attachment` |
| Images (`.png` / `.jpg` / `.jpeg` / `.webp` / `.gif`) | Correct image `Content-Type`, `Content-Disposition: inline` (so chat `<img>` previews work) |
| Other types | Matching text/PDF types when known; otherwise `application/octet-stream` + attachment |

Example URL returned on a step event: `/api/artifacts/image-1729000000000.png`.

### SSE run events (`GET /api/events`)

When a tool produces a file, the `step` event may include:

```json
{
  "type": "step",
  "step": 3,
  "toolName": "generate_image",
  "ok": true,
  "message": "Generated image \"…\" …",
  "artifactUrl": "/api/artifacts/image-….png"
}
```

The chat UI renders image `artifactUrl` values inline; non-image artifacts remain download links in the agent summary.
