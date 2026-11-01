const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("workspace context shares product, peer expertise, and funnel map without transcript spam", () => {
  const html = readFileSync(join(__dirname, "..", "static", "index.html"), "utf8");
  const start = html.indexOf("function botExpertiseLine(bot)");
  const end = html.indexOf("function conversationMemoryPayload(agent)");
  assert.ok(start > 0 && end > start, "workspace context helpers must exist in index.html");
  const agents = [
    {
      id: "pm",
      name: "Magicsite.AI - Product Marketing Bot",
      description: "Coordinate the bots to grow MagicSite.ai and measure the full funnel.",
      summary: "Coordinate the bots to grow MagicSite.ai and measure the full funnel.",
      intent: { summary: "Coordinate the bots to grow MagicSite.ai and measure the full funnel.", expertise: "product marketing" },
      transcript: [
        { role: "user", html: "now give me a complete plan of which bots going to work" },
        { role: "agent", html: "noisy status dump that should not dominate context" }
      ]
    },
    {
      id: "seo",
      name: "SEO Specialist",
      description: "Keywords → GA4/GTM → content clusters",
      intent: { summary: "Keywords → GA4/GTM → content clusters", expertise: "SEO" },
      transcript: [{ role: "user", html: "research keywords for home service owners" }]
    },
    {
      id: "funnel",
      name: "Funnel Specialist",
      description: "Conversion-funnel strategist",
      intent: { summary: "Stages → drop-offs → one experiment", expertise: "funnels" },
      transcript: []
    }
  ];
  const sandbox = {
    agents,
    localStorage: {
      store: Object.create(null),
      getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; },
      setItem(key, value) { this.store[key] = String(value); }
    },
    extractPlainText(htmlText) {
      return String(htmlText || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
  };
  vm.runInNewContext(html.slice(start, end) + "\nthis.api = { buildWorkspaceBotsContext };", sandbox);
  const context = sandbox.api.buildWorkspaceBotsContext(agents[0]);
  assert.match(context, /WORKSPACE PRODUCT/);
  assert.match(context, /MagicSite\.ai/);
  assert.match(context, /TEAM EXPERTISE/);
  assert.match(context, /SEO Specialist/);
  assert.match(context, /Funnel Specialist/);
  assert.match(context, /FUNNEL COLLABORATION MAP/);
  assert.match(context, /Discover:/);
  assert.match(context, /Convert:/);
  assert.doesNotMatch(context, /noisy status dump/);
  assert.match(context, /COLLABORATION DOCTRINE/);
});
