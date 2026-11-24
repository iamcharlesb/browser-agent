import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchUrlText, hostedSearchConfig, htmlToText, pageImageCandidates } from "./webResearch";

test("photo pages retain actual image URLs, including lazy images and social previews", () => {
  const html = `<meta property="og:image" content="https://cdn.example.test/hero.jpg?w=1600&amp;fit=crop">
    <img src="data:image/gif;base64,placeholder" data-src="/photos/garden.jpg">
    <img src="/photos/garden.jpg"><img src="javascript:alert(1)">
    <img src="https://user:password@example.test/private.jpg">
    <script>const fake = '<img src="/invented.jpg">';</script>
    <!-- <img src="/comment.jpg"> -->`;
  assert.deepEqual(pageImageCandidates(html, "https://stock.example.test/photo/garden"), [
    "https://cdn.example.test/hero.jpg?w=1600&fit=crop", "https://stock.example.test/photos/garden.jpg"
  ]);
  assert.equal(pageImageCandidates(Array.from({ length: 20 }, (_, i) => `<img src="/${i}.jpg">`).join(""), "https://example.test/").length, 12);
});

test("page text drops scripts, styles and navigation and keeps readable lines", () => {
  const { title, text } = htmlToText("<html><head><title>Hibiscus &amp; Co</title><style>p{}</style></head><body><nav>Menu</nav><p>Price: $49</p><script>track()</script><p>Ships to 95119</p></body></html>");
  assert.equal(title, "Hibiscus & Co");
  assert.match(text, /Price: \$49\nShips to 95119/);
  assert.doesNotMatch(text, /Menu|track/);
});

test("page reader refuses local and private network addresses", async () => {
  for (const url of ["http://localhost:8766/api/settings", "http://127.0.0.1/", "http://10.0.0.5/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[64:ff9b::7f00:1]/", "http://[fe80::1]/", "http://169.254.169.254/latest", "file:///etc/passwd"]) {
    await assert.rejects(fetchUrlText(url), /local|private|http\(s\)/, url);
  }
});

test("hosted search is skipped when the scrape backend is configured", () => {
  const previous = process.env.BROWSER_AGENT_SEARCH_BACKEND;
  process.env.BROWSER_AGENT_SEARCH_BACKEND = "scrape";
  try { assert.equal(hostedSearchConfig(), null); }
  finally { if (previous === undefined) delete process.env.BROWSER_AGENT_SEARCH_BACKEND; else process.env.BROWSER_AGENT_SEARCH_BACKEND = previous; }
});
