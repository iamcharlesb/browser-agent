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
