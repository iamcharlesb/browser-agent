import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchUrlText, hostedSearchConfig, htmlToText } from "./webResearch";

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
