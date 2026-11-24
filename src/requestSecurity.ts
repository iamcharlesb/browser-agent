/** Browser request boundary for the local, single-operator server.
 * Validate Host independently of Origin to reject DNS rebinding. Local CLI clients
 * send Origin explicitly; this is not authentication against other local processes.
 */
import type { IncomingMessage } from "node:http";

export function isSameOriginRequest(req: IncomingMessage): boolean {
  if (!req.headers.origin || !req.headers.host) return false;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted ? "https:" : "http:";
    return origin.origin === `${protocol}//${req.headers.host}`;
  } catch { return false; }
}

export function requestRejection(req: IncomingMessage, pathname: string, configuredHost: string, configuredPort: number): string | null {
  try {
    const host = new URL(`http://${req.headers.host || ""}`);
    const allowed = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (!["0.0.0.0", "::"].includes(configuredHost)) allowed.add(configuredHost.toLowerCase());
    if (!allowed.has(host.hostname) || Number(host.port || 80) !== (req.socket.localPort ?? configuredPort) ||
        host.username || host.password || host.pathname !== "/" || host.search || host.hash) {
      return "Untrusted request host.";
    }
  } catch { return "Invalid request host."; }
  // Google's form POST has its own nonce, double-submit CSRF and ID-token checks.
  if (req.method === "POST" && pathname === "/api/auth/google/callback") return null;
  if (req.headers.origin && !isSameOriginRequest(req)) return "Requests must come from this app.";
  if (!["GET", "HEAD"].includes(req.method || "") && !isSameOriginRequest(req)) {
    return "State-changing requests require this app's Origin.";
  }
  return null;
}
