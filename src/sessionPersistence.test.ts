import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

test("closing and reopening restores the selected conversation and separate drafts without submitting work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbots-reopen-"));
  let submissions = 0;
  async function open() {
    const context = await chromium.launchPersistentContext(directory, { headless: true });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== "session.test") return route.abort();
      if (url.pathname.startsWith("/api/")) {
        if (route.request().method() === "POST" && /\/api\/(run|learn|workflow|schedules)/.test(url.pathname)) submissions++;
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ isRunning: false, models: [], schedules: [], events: [], jobs: [], workflows: [], suggestions: [], user: null }) });
      }
      if (!["/", "/botCharacterArtwork.js", "/botCharacters.js", "/botCharacters.css", "/browserRuntime.js", "/botCatalog.js", "/uiState.js", "/responseMarkdown.js", "/runStream.js"].includes(url.pathname)) return route.abort();
      const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      return route.fulfill({ contentType: filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : "text/html", body: await readFile(join(__dirname, "..", "static", filename)) });
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto("http://session.test/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".template-card[data-name='Andrej Karpathy']", { state: "attached" });
    return { context, page };
  }
  let current: Awaited<ReturnType<typeof open>> | undefined;
  try {
    current = await open();
    await current.page.evaluate(() => {
      localStorage.setItem("agentFireworksAgentsV2", JSON.stringify([
        { id: "saved-a", name: "Research", description: "Research", transcript: [{ role: "user", html: "Keep the original experiment" }, { role: "agent", html: "Baseline recorded" }] },
        { id: "saved-b", name: "Writer", description: "Write", transcript: [] }
      ]));
    });
    await current.page.reload();
    await current.page.locator('#agent-list .agent-row[data-agent-id="saved-a"]').click();
    await current.page.locator("#prompt").fill("Unfinished research draft");
    await current.page.locator('#agent-list .agent-row[data-agent-id="saved-b"]').click();
    assert.equal(await current.page.locator("#prompt").inputValue(), "");
    await current.page.locator("#prompt").fill("Unfinished writing draft");
    await current.context.close();
    current = await open();
    assert.equal(await current.page.locator("#chip-name").textContent(), "Writer");
    assert.equal(await current.page.locator("#prompt").inputValue(), "Unfinished writing draft");
    await current.page.locator('#agent-list .agent-row[data-agent-id="saved-a"]').click();
    assert.equal(await current.page.locator("#prompt").inputValue(), "Unfinished research draft");
    assert.match(await current.page.locator("#messages").textContent() || "", /Keep the original experiment/);
    assert.match(await current.page.locator("#messages").textContent() || "", /Baseline recorded/);
    await current.page.locator("#prompt").fill("");
    await current.context.close();
    current = await open();
    assert.equal(await current.page.locator("#chip-name").textContent(), "Research");
    assert.equal(await current.page.locator("#prompt").inputValue(), "", "a cleared draft cannot reappear");
    assert.equal(submissions, 0, "reopening cannot submit or repeat work");
  } finally {
    await current?.context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
