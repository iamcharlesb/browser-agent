/**
 * Deterministic QA for generated HTML pages, run by create_document before a page is handed over.
 *
 * Models routinely ship pages whose hero photo is a hotlink that never renders, or whose button
 * text is unreadable on its own background, and then describe the page as verified. Those are
 * facts the runtime can check, so it checks them: remote images are fetched through the same
 * public-network guard as fetch_url and embedded so the downloaded file is self-contained, and
 * static lint results go back to the model in the tool result so it repairs the page before
 * finishing. Lint is heuristic and never blocks saving.
 */
import { fetchPublic } from "./webResearch";

export interface ImageFetch { ok: boolean; status: number; type: string; bytes: Buffer | null; error?: string }
export type ImageFetcher = (url: string) => Promise<ImageFetch>;
export interface HtmlPreparation { html: string; inlined: string[]; warnings: string[] }

const MAX_IMAGES = 12;
const MAX_INLINE_BYTES = 900_000;
const MAX_TOTAL_INLINE_BYTES = 4_500_000;
const INLINE_TYPES = /^image\/(?:jpeg|png|webp|gif|avif|svg\+xml)$/;

export async function fetchImageOverPublicNetwork(url: string): Promise<ImageFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const { response } = await fetchPublic(url, controller.signal, "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8");
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!response.ok) return { ok: false, status: response.status, type, bytes: null };
    return { ok: true, status: response.status, type, bytes: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    return { ok: false, status: 0, type: "", bytes: null, error: error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timer); }
}

function decodeImageUrl(value: string): string { return value.replace(/&amp;/g, "&"); }

function remoteImageUrls(html: string): string[] {
  const urls = new Set<string>();
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const match of source.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"(https?:\/\/[^"]+)"|'(https?:\/\/[^']+)')/gi)) urls.add(decodeImageUrl(match[1] ?? match[2]));
  for (const match of source.matchAll(/url\(\s*(?:"(https?:\/\/[^"]+)"|'(https?:\/\/[^']+)'|(https?:\/\/[^)\s"']+))\s*\)/gi)) urls.add(decodeImageUrl(match[1] ?? match[2] ?? match[3]));
  return [...urls].filter(url => url.length <= 2048).slice(0, MAX_IMAGES);
}

function short(url: string): string { return url.length > 110 ? `${url.slice(0, 107)}...` : url; }

async function inlineRemoteImages(html: string, fetchImage: ImageFetcher): Promise<{ html: string; inlined: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const inlined: string[] = [];
  let total = 0;
  let output = html;
  for (const url of remoteImageUrls(html)) {
    const result = await fetchImage(url);
    if (!result.ok || !result.bytes) {
      warnings.push(`BROKEN IMAGE: ${short(url)} did not load (${result.status ? `HTTP ${result.status}` : result.error || "no response"}). Use a different verified image URL or remove it; do not ship a missing photo.`);
      continue;
    }
    if (!INLINE_TYPES.test(result.type)) {
      warnings.push(`NOT AN IMAGE: ${short(url)} returned ${result.type || "an unknown content type"}. Find the direct image file URL on the source page.`);
      continue;
    }
    if (result.bytes.length > MAX_INLINE_BYTES || total + result.bytes.length > MAX_TOTAL_INLINE_BYTES) {
      warnings.push(`LARGE IMAGE kept as a link: ${short(url)} is ${Math.round(result.bytes.length / 1024)} KB. Choose a smaller rendition (about 960px wide) so the page stays self-contained.`);
      continue;
    }
    total += result.bytes.length;
    inlined.push(url);
    const data = `data:${result.type};base64,${result.bytes.toString("base64")}`;
    // Replace only complete image references; credits, scripts and longer URLs must stay intact.
    output = output.replace(/(<img\b[^>]*?\ssrc\s*=\s*)(["'])(.*?)\2/gi,
      (match, prefix, quote, value) => decodeImageUrl(value) === url ? `${prefix}${quote}${data}${quote}` : match);
    output = output.replace(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s"']+))\s*\)/gi,
      (match, double, single, bare) => decodeImageUrl(double ?? single ?? bare) === url ? `url("${data}")` : match);
  }
  return { html: output, inlined, warnings };
}

function parseColor(value: string): [number, number, number] | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split("").map(char => char + char).join("") : hex[1];
    return [0, 2, 4].map(index => parseInt(digits.slice(index, index + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(text);
  if (rgb && (rgb[4] === undefined || parseFloat(rgb[4]) >= 0.95)) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const named: Record<string, [number, number, number]> = { white: [255, 255, 255], black: [0, 0, 0] };
  return named[text] ?? null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => { const s = value / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground: [number, number, number], background: [number, number, number]): number {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Finds rules whose own text and background colors are both solid and too close to read. */
export function lowContrastRules(html: string): string[] {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const variables = new Map<string, string>();
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) variables.set(match[1], match[2].trim());
  const resolve = (value: string): string => {
    let current = value.trim();
    for (let depth = 0; depth < 4; depth += 1) {
      const reference = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(current);
      if (!reference) break;
      current = (variables.get(reference[1]) ?? reference[2] ?? "").trim();
    }
    return current;
  };
  const findings: string[] = [];
  for (const rule of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, " ");
    if (!selector || selector.startsWith(":root")) continue;
    const declarations = new Map<string, string>();
    for (const declaration of rule[2].split(";")) {
      const separator = declaration.indexOf(":");
      if (separator > 0) declarations.set(declaration.slice(0, separator).trim().toLowerCase(), declaration.slice(separator + 1).trim());
    }
    const textValue = declarations.get("color");
    const backgroundValue = declarations.get("background-color") ?? declarations.get("background");
    if (!textValue || !backgroundValue || /gradient|url\(/i.test(backgroundValue)) continue;
    const text = parseColor(resolve(textValue));
    const background = parseColor(resolve(backgroundValue));
    if (!text || !background) continue;
    const ratio = contrastRatio(text, background);
    if (ratio < 3) findings.push(`LOW CONTRAST: "${selector.slice(0, 60)}" text on its background is ${ratio.toFixed(1)}:1 (needs at least 4.5:1 for body text, 3:1 for large text). Change the text or background color.`);
  }
  return findings.slice(0, 6);
}

export function lintHtml(html: string): string[] {
  const warnings: string[] = [];
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) warnings.push('MISSING VIEWPORT: add <meta name="viewport" content="width=device-width, initial-scale=1"> so the page is usable on phones.');
  if (!/<title>\s*\S/i.test(html)) warnings.push("MISSING TITLE: add a descriptive <title>.");
  if (!/<h1\b/i.test(html)) warnings.push("MISSING H1: the page needs one h1 that states the main promise.");
  const missingAlt = (html.match(/<img\b(?![^>]*\balt\s*=)[^>]*>/gi) || []).length;
  if (missingAlt) warnings.push(`IMAGES WITHOUT ALT: ${missingAlt} <img> tag(s) need descriptive alt text (use alt="" only for decoration).`);
  if (/lorem ipsum/i.test(html)) warnings.push("PLACEHOLDER COPY: remove lorem ipsum; write real copy or mark the gap in [brackets] for the owner.");
  const deadLinks = (html.match(/\shref=["']#["']/gi) || []).length;
  if (deadLinks > 2) warnings.push(`DEAD LINKS: ${deadLinks} links point to "#". Point them at real sections (#id) or mark them as placeholders.`);
  const ids = new Set([...html.matchAll(/\sid=["']([^"']+)["']/gi)].map(match => match[1]));
  const missingTargets = [...new Set([...html.matchAll(/\shref=["']#([\w-]+)["']/gi)].map(match => match[1]))].filter(target => !ids.has(target));
  if (missingTargets.length) warnings.push(`BROKEN ANCHORS: no element has id="${missingTargets.slice(0, 5).join('", "')}" for the in-page link(s) that point there.`);
  warnings.push(...lowContrastRules(html));
  return warnings;
}

/** Embeds reachable remote images and reports what still needs fixing. Never throws. */
export async function prepareHtmlArtifact(html: string, fetchImage: ImageFetcher = fetchImageOverPublicNetwork): Promise<HtmlPreparation> {
  try {
    const images = await inlineRemoteImages(html, fetchImage);
    return { html: images.html, inlined: images.inlined, warnings: [...images.warnings, ...lintHtml(html)] };
  } catch (error) {
    return { html, inlined: [], warnings: [`QA SKIPPED: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function qualityReport(result: HtmlPreparation): string {
  const lines: string[] = [];
  if (result.inlined.length) lines.push(`Embedded ${result.inlined.length} remote image(s) so the file is self-contained.`);
  if (result.warnings.length) {
    lines.push(`PAGE QA found ${result.warnings.length} issue(s). Fix them and call create_document again with the same filename before you finish:`);
    lines.push(...result.warnings.map(warning => `- ${warning}`));
  } else lines.push("PAGE QA passed: sampled remote images fetched, required tags present, no low-contrast rules found by static lint. This does not replace looking at the rendered page.");
  return lines.join("\n");
}
