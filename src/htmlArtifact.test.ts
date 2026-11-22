import assert from "node:assert/strict";
import { test } from "node:test";
import { contrastRatio, lintHtml, lowContrastRules, prepareHtmlArtifact, qualityReport, type ImageFetch } from "./htmlArtifact";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const okImage: ImageFetch = { ok: true, status: 200, type: "image/png", bytes: png };
const page = (body: string, head = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T</title>${head}</head><body><h1>Hi</h1>${body}</body></html>`;

test("reachable remote images are embedded so the file is self-contained", async () => {
  const html = page('<img src="https://example.test/a.png" alt="A" width="10" height="10">');
  const result = await prepareHtmlArtifact(html, async () => okImage);
  assert.deepEqual(result.inlined, ["https://example.test/a.png"]);
  assert.match(result.html, /src="data:image\/png;base64,/);
  assert.ok(!result.html.includes("https://example.test/a.png"));
  assert.deepEqual(result.warnings, []);
  assert.match(qualityReport(result), /PAGE QA passed/);
});

test("broken and non-image URLs are reported instead of shipped silently", async () => {
  const html = page('<img src="https://example.test/missing.jpg" alt="x"><img src="https://example.test/page" alt="y">');
  const result = await prepareHtmlArtifact(html, async url => url.endsWith("missing.jpg")
    ? { ok: false, status: 404, type: "", bytes: null }
    : { ok: true, status: 200, type: "text/html", bytes: Buffer.from("<html>") });
  assert.equal(result.inlined.length, 0);
  assert.ok(result.warnings.some(warning => /BROKEN IMAGE.*HTTP 404/.test(warning)));
  assert.ok(result.warnings.some(warning => /NOT AN IMAGE/.test(warning)));
  assert.match(qualityReport(result), /create_document again/);
});

test("oversized images stay linked with a warning to pick a smaller rendition", async () => {
  const html = page('<img src="https://example.test/big.jpg" alt="x">');
  const result = await prepareHtmlArtifact(html, async () => ({ ok: true, status: 200, type: "image/jpeg", bytes: Buffer.alloc(1_000_000) }));
  assert.equal(result.inlined.length, 0);
  assert.ok(result.html.includes("https://example.test/big.jpg"));
  assert.ok(result.warnings.some(warning => /LARGE IMAGE/.test(warning)));
});

test("css background images are embedded too", async () => {
  const html = page("<div class=hero></div>", "<style>.hero{background:url(https://example.test/h.png) center/cover}</style>");
  const result = await prepareHtmlArtifact(html, async () => okImage);
  assert.equal(result.inlined.length, 1);
  assert.match(result.html, /url\("data:image\/png;base64,/);
});

test("embedding preserves credit links and longer URLs and decodes HTML query separators", async () => {
  const url = "https://example.test/a.png";
  const result = await prepareHtmlArtifact(page(`<a href="${url}">Credit</a><img src="${url}" alt="A"><img src="${url}?w=2&amp;h=3" alt="B">`), async value => {
    assert.ok(value === url || value === `${url}?w=2&h=3`);
    return okImage;
  });
  assert.equal(result.inlined.length, 2);
  assert.ok(result.html.includes(`href="${url}"`));
  assert.equal((result.html.match(/src="data:/g) || []).length, 2);
});

test("contrast lint supports RGB backgrounds with spaces", () => {
  assert.equal(lowContrastRules(page("", "<style>.cta{background:rgb(20, 20, 20);color:rgb(30, 30, 30)}</style>")).length, 1);
});

test("a fetcher that throws never blocks saving the page", async () => {
  const html = page('<img src="https://example.test/a.png" alt="x">');
  const result = await prepareHtmlArtifact(html, async () => { throw new Error("offline"); });
  assert.match(result.warnings.join("\n"), /QA SKIPPED: offline/);
  assert.equal(result.html, html);
});

test("contrast lint resolves css variables and catches dark text on a dark button", () => {
  const css = ":root{--ink:#222222;--terra:#8a3d2a;--cream:#f4efe6}.cta{background:var(--terra);color:var(--ink)}.ok{background:var(--cream);color:var(--ink)}";
  const findings = lowContrastRules(page("<a class=cta>Book</a>", `<style>${css}</style>`));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /\.cta/);
  assert.ok(contrastRatio([0, 0, 0], [255, 255, 255]) > 20);
});

test("static lint flags structural gaps and passes a sound page", () => {
  const bad = "<html><head></head><body><img src='x.png'><a href='#'>a</a><a href='#'>b</a><a href='#'>c</a><a href='#menu'>m</a>lorem ipsum</body></html>";
  const text = lintHtml(bad).join("\n");
  for (const code of ["MISSING VIEWPORT", "MISSING TITLE", "MISSING H1", "IMAGES WITHOUT ALT", "PLACEHOLDER COPY", "DEAD LINKS", "BROKEN ANCHORS"]) assert.match(text, new RegExp(code));
  assert.deepEqual(lintHtml(page('<img src="a.png" alt="x"><a href="#menu">m</a><nav id="menu"></nav>')), []);
});
