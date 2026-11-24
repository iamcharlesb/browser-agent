/** Terminal HTTP routes. Request security is enforced before dispatch. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { WORKSPACE_ROOT, clearTerminalHistory, getTerminalHistory, runTerminalCommand } from "./agentTools";
import { assessTaskRisk } from "./security";

export async function handleTerminalRequest(req: IncomingMessage, res: ServerResponse, url: URL, dependencies: {
  readJsonBody: (req: IncomingMessage) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void;
  terminalControllers: Set<AbortController>;
}): Promise<boolean> {
  const { readJsonBody, sendJson, terminalControllers } = dependencies;
  if (req.method === "GET" && url.pathname === "/api/terminal") {
    sendJson(res, 200, {
      ok: true,
      cwd: WORKSPACE_ROOT,
      history: getTerminalHistory()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/terminal") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const command = typeof body.command === "string" ? body.command.trim() : "";
      const cwd = typeof body.cwd === "string" ? body.cwd.trim() : undefined;
      if (!command) {
        sendJson(res, 400, { detail: "command is required." });
        return true;
      }
      const risk = assessTaskRisk(command);
      if (risk.blocked) {
        sendJson(res, 403, { detail: risk.reason, code: "credential_exposure_blocked" });
        return true;
      }
      const controller = new AbortController();
      terminalControllers.add(controller);
      try {
        const entry = await runTerminalCommand(command, cwd, 20_000, "user", controller.signal);
        sendJson(res, 200, { ok: entry.exitCode === 0, entry });
      } finally { terminalControllers.delete(controller); }
    } catch (err) {
      sendJson(res, 400, { detail: (err as Error).message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/terminal/clear") {
    clearTerminalHistory();
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
