import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { envInteger } from "./runtimeConfig";
import { artifactUrlFor } from "./apiContract";

export interface RecordingRequest {
  id: string;
  durationSeconds: number;
  state: "pending" | "recording" | "completed" | "failed";
  createdAt: number;
  artifactUrl?: string;
  error?: string;
}
export function recordingConfig() {
  return {
    maxSeconds: envInteger("BROWSER_AGENT_RECORDING_MAX_SECONDS", 120, 1, 3600),
    maxBytes: envInteger("BROWSER_AGENT_RECORDING_MAX_BYTES", 100_000_000, 1024, 1_000_000_000),
    bitrate: envInteger("BROWSER_AGENT_RECORDING_BITRATE", 8_000_000, 100_000, 50_000_000),
    fps: envInteger("BROWSER_AGENT_RECORDING_FPS", 30, 1, 60),
    pollMs: envInteger("BROWSER_AGENT_RECORDING_POLL_MS", 2000, 500, 30000)
  };
}
export class RecordingStore {
  private current?: RecordingRequest;
  request(seconds: unknown = 10): RecordingRequest {
    const durationSeconds = Number(seconds);
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > recordingConfig().maxSeconds) {
      throw new Error(`Recording duration must be 1–${recordingConfig().maxSeconds} seconds.`);
    }
    if (this.current && ["pending", "recording"].includes(this.current.state)) return { ...this.current };
    this.current = { id: randomUUID(), durationSeconds, state: "pending", createdAt: Date.now() };
    return { ...this.current };
  }
  get() { return this.current ? { ...this.current } : null; }
  transition(id: string, state: "recording" | "failed", error?: string) {
    if (!this.current || this.current.id !== id) throw new Error("Recording request is no longer active.");
    if (state === "recording" && this.current.state !== "pending") throw new Error("Recording has already started.");
    if (["completed", "failed"].includes(this.current.state)) throw new Error("Recording has already finished.");
    this.current.state = state;
    this.current.error = error?.slice(0, 300);
    return this.get();
  }
  async save(id: string, bytes: Buffer, directory: string) {
    if (!this.current || this.current.id !== id || this.current.state !== "recording") throw new Error("No active recording to save.");
    if (bytes.length < 32 || !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) throw new Error("Expected a recorded WebM video.");
    if (bytes.length > recordingConfig().maxBytes) throw new Error("Recording exceeds the configured file size limit.");
    await mkdir(directory, { recursive: true });
    const filename = `pilo-recording-${id}.webm`;
    await writeFile(join(directory, filename), bytes, { flag: "wx", mode: 0o600 });
    // A concurrent cancellation cannot revive a failed request.
    if (this.current.id === id && this.current.state === "recording") {
      this.current.state = "completed";
      this.current.artifactUrl = artifactUrlFor(filename);
    }
    return this.get();
  }
}
export const screenRecordings = new RecordingStore();

export async function handleRecordingRequest(req: IncomingMessage, res: ServerResponse, url: URL, directory: string) {
  if (!url.pathname.startsWith("/api/recordings")) return false;
  const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === "GET" && url.pathname === "/api/recordings") {
      send(200, { recording: screenRecordings.get(), config: recordingConfig() }); return true;
    }
    if (req.method !== "POST" || !req.headers.origin || req.headers.origin !== `http://${req.headers.host}`) {
      send(403, { detail: "Recording changes require this app's Origin." }); return true;
    }
    const upload = /^\/api\/recordings\/([^/]+)\/video$/.exec(url.pathname);
    if (upload) {
      if (!/^video\/webm(?:;|$)/i.test(req.headers["content-type"] || "")) throw new Error("Expected video/webm.");
      const parts: Buffer[] = []; let total = 0;
      for await (const part of req) {
        total += part.length;
        if (total > recordingConfig().maxBytes) throw new Error("Recording exceeds the configured file size limit.");
        parts.push(Buffer.from(part));
      }
      send(200, { recording: await screenRecordings.save(upload[1], Buffer.concat(parts), directory) }); return true;
    }
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 2048) throw new Error("Request too large."); }
    const body = JSON.parse(raw || "{}");
    if (url.pathname === "/api/recordings") send(200, { recording: screenRecordings.request(body.durationSeconds ?? 10) });
    else {
      const match = /^\/api\/recordings\/([^/]+)\/(start|fail)$/.exec(url.pathname);
      if (!match) { send(404, { detail: "Unknown recording route." }); return true; }
      send(200, { recording: screenRecordings.transition(match[1], match[2] === "start" ? "recording" : "failed", "Recording stopped or capture permission was denied.") });
    }
  } catch (error) { send(400, { detail: (error as Error).message }); }
  return true;
}
