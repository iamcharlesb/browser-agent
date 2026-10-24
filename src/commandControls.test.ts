import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { runTerminalCommand, WORKSPACE_ROOT } from "./agentTools";
import { BrowserController } from "./browserController";

const html = readFileSync(join(__dirname, "../static/index.html"), "utf8");
function source(name: string, next: string): string {
  return html.slice(html.indexOf(`  function ${name}(`), html.indexOf(next, html.indexOf(`  function ${name}(`)));
}

test("queued commands can be removed, steered and dispatched in order without stopping on enqueue", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    page.setDefaultTimeout(5000);
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<html><head></head><body><div id='command-queue'></div></body></html>" }));
    await page.goto("https://agent.test");
    await page.addStyleTag({ content: "body{font-family:system-ui;background:#f8f9fb;padding:24px}" + Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)).map(match => match[1]).join("\n") });
    await page.addScriptTag({ content: `
      var queuedRunsAfterActive=[], queuedRunPoll=null, steeringInFlight=false, queueStopVersion=0;
      var activeAgentId='bot', runConversationAgentId='bot', isRunning=true, startRunLock=false;
      var runEvents={close:function(){runEvents=null;}}, learnEvents=null, waitingForRunInput=true;
      var calls=[], starts=[], serverRunning=true, sendButton={}, status={};
      var agents=[{id:'bot'}], eventMessageAgent=null;
      function activeAgent(){return agents[0];}
      function readResponse(body){return body;}
      function fetch(url){calls.push(url); return Promise.resolve({isRunning:serverRunning});}
      function connectRunEvents(){}
      function clearRunClientState(){isRunning=false;}
      function setStatusState(){}
      function appendMessage(){}
      function startRun(task){starts.push(task); serverRunning=true; isRunning=true;}
      function startLearnSession(){}
      ${source("renderCommandQueue", "\n  function steerQueuedCommand")}
      ${source("steerQueuedCommand", "\n  function queueRunAfterActive")}
      ${source("queueRunAfterActive", "\n  function clearRunClientState")}
      ${source("scheduleQueuedRun", "\n  function screenshotHtml")}
      ${source("stopRun", "\n  var learnEvents")}
      queueRunAfterActive('First command'); queueRunAfterActive('Second command');
    ` });
    assert.equal(await page.locator(".queued-command").count(), 2);
    assert.equal(await page.evaluate(() => (window as any).calls.includes("/api/stop")), false);
    await page.getByRole("button", { name: "Remove queued command" }).first().click();
    assert.equal(await page.locator(".queued-command-text").innerText(), "Second command");
    await page.evaluate(() => (window as any).queueRunAfterActive("Updated instruction"));
    await page.getByRole("button", { name: "↳ Steer" }).last().click();
    await page.waitForFunction(() => !(window as any).steeringInFlight);
    assert.match(await page.locator(".queued-command-text").first().innerText(), /Updated instruction/);
    assert.equal(await page.evaluate(() => (window as any).calls.filter((url: string) => url === "/api/stop").length), 1);
    await page.screenshot({ path: "/tmp/agent-command-queue.png" });
    await page.evaluate(() => { (window as any).serverRunning = false; });
    await page.waitForFunction(() => (window as any).starts.length === 1);
    assert.match(await page.evaluate(() => (window as any).starts[0]), /updated user instruction.*Updated instruction/i);
    await page.evaluate(() => { (window as any).serverRunning = false; });
    await page.waitForFunction(() => (window as any).starts.length === 2);
    assert.equal(await page.evaluate(() => (window as any).starts[1]), "Second command");
    await page.evaluate(() => { (window as any).queueRunAfterActive("Must not run"); (window as any).stopRun(); });
    assert.equal(await page.locator("#command-queue").isHidden(), true);
    assert.equal(await page.evaluate(() => (window as any).queuedRunsAfterActive.length), 0);
  } finally { await browser.close(); }
});

test("payment labels are read from selectors, icons and checkout Enter controls", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="pay" aria-label="Pay now"><span id="icon">$</span></button><form><input autocomplete="cc-number" id="card"></form>');
    const controller = Object.create(BrowserController.prototype);
    controller.ensureActivePage = async () => page;
    assert.equal((await controller.inspectActionTarget("click_element", { target: "#pay" })).label, "Pay now");
    const rect = await page.locator("#icon").boundingBox();
    assert.ok(rect);
    assert.equal((await controller.inspectActionTarget("click_coords", { x: rect.x + 1, y: rect.y + 1, label: "Continue" })).label, "Pay now");
    await page.locator("#card").focus();
    assert.equal((await controller.inspectActionTarget("key_press", { key: "Enter" })).label, "Submit payment");
  } finally { await browser.close(); }
});

test("Stop kills terminal child processes before they can perform later work", async () => {
  const dir = await mkdtemp(join(WORKSPACE_ROOT, ".cancel-test-"));
  const marker = join(dir, "must-not-exist");
  try {
    const controller = new AbortController();
    const result = runTerminalCommand("sleep 1; printf late > must-not-exist", dir, 5000, "agent", controller.signal);
    setTimeout(() => controller.abort(), 80);
    const entry = await result;
    assert.notEqual(entry.exitCode, 0);
    assert.match(entry.stderr, /Stopped by user/);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(existsSync(marker), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
