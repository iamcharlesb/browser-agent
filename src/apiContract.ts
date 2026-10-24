/**
 * Public HTTP + SSE contract for the browser agent UI and external clients.
 * Keep handlers in server.ts aligned with these shapes.
 */

/** Safe artifact filename (server also re-sanitizes path segments). */
export type ArtifactFilename = string;

export interface ArtifactMeta {
  filename: ArtifactFilename;
  /** Absolute or root-relative URL path, e.g. `/api/artifacts/image-123.png`. */
  url: string;
  contentType: string;
  /** When true, clients may embed the body (e.g. `<img src>`). */
  inline: boolean;
}

/** Query: `GET /api/artifacts/:filename` — optional `?download=1` forces attachment. */
export interface ArtifactGetQuery {
  download?: "1" | "true";
}

/** JSON error body for missing/invalid artifacts. */
export interface ArtifactErrorBody {
  detail: string;
}

/** SSE `step` payload fields relevant to generated files / images. */
export interface RunStepArtifactFields {
  type: "step";
  step: number;
  toolName?: string;
  ok?: boolean;
  message?: string;
  /** Present when a tool wrote a downloadable/inline file under `/api/artifacts/`. */
  artifactUrl?: string;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

export function isImageArtifactUrl(url: string): boolean {
  return IMAGE_EXT.test(url);
}

export function artifactContentType(filename: string): Pick<ArtifactMeta, "contentType" | "inline"> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return { contentType: "image/png", inline: true };
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return { contentType: "image/jpeg", inline: true };
  if (lower.endsWith(".webp")) return { contentType: "image/webp", inline: true };
  if (lower.endsWith(".gif")) return { contentType: "image/gif", inline: true };
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return { contentType: "text/html; charset=utf-8", inline: true };
  }
  if (lower.endsWith(".md")) return { contentType: "text/markdown; charset=utf-8", inline: true };
  if (lower.endsWith(".txt")) return { contentType: "text/plain; charset=utf-8", inline: true };
  if (lower.endsWith(".pdf")) return { contentType: "application/pdf", inline: true };
  return { contentType: "application/octet-stream", inline: false };
}

export function artifactUrlFor(filename: string): string {
  return `/api/artifacts/${encodeURIComponent(filename)}`;
}

/**
 * When the UI opens the live browser while a task may already own Chromium,
 * reuse the active session instead of rejecting with a scary conflict error.
 */
export function resolveLoginDuringRun(opts: {
  runIsActive: boolean;
  hasActiveSession: boolean;
  modeChanged?: boolean;
}): "reuse" | "busy" | "open" {
  if (!opts.runIsActive) return "open";
  if (opts.hasActiveSession && !opts.modeChanged) return "reuse";
  return "busy";
}

/** Shared busy-run detection for /api/run and /api/login conflict responses. */
export function isRunInProgressMessage(message: string): boolean {
  return /in progress/i.test(message || "");
}

/** Bound live-preview sizes before applying Chromium device metrics. */
export function browserViewportSize(width: unknown, height: unknown): { width: number; height: number } {
  const w = Number(width), h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error("Browser viewport dimensions must be positive finite numbers.");
  }
  return { width: Math.max(320, Math.min(4096, Math.round(w))), height: Math.max(240, Math.min(4096, Math.round(h))) };
}
