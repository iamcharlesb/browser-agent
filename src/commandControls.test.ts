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
      var queuedRunsAfterActive=[], queuedRunPoll=null, steeringInFlight=false, queueStopVersions=Object.create(null);
      var activeAgentId='bot', runConversationAgentId='bot', isRunning=true, startRunLock=false;
      var runEvents={close:function(){runEvents=null;}}, learnEvents=null, waitingForRunInput=true;
      var calls=[], starts=[], serverRunning=true, sendButton={}, status={};
      var agents=[{id:'bot'}], eventMessageAgent=null;
      function activeAgent(){return agents[0];}
      function readResponse(body){return body;}
      var nextJob=0, serverJobs={};
      function fetch(url, options){
        calls.push(url);
        if(url.indexOf('/api/run/queue')===0) {var id='job_'+(++nextJob);serverJobs[id]={id:id,status:'queued',task:JSON.parse(options.body).task};return Promise.resolve(serverJobs[id]);}
        if(url.indexOf('/api/run/jobs/')===0) {
          var id=url.split('/').pop(),job=serverJobs[id];
          if(options&&options.method==='DELETE'){job.status='cancelled';return Promise.resolve(job);}
          if(!serverRunning&&job.status==='queued'){job.status='running';job.runId='run_'+id;serverRunning=true;}
          return Promise.resolve(job);
        }
        return Promise.resolve({isRunning:serverRunning});
      }
      function focusComposer(){}
      var runTracker={activeFor:function(){return serverRunning?{runId:'active_run'}:null;},list:function(){return [];},cancelFollowing:function(){},subscribe:function(run){starts.push(serverJobs[run.jobId].task);serverRunning=true;}};
      function restoreSelectedRun(){}
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
      buildAgentRunPayload=function(task){return {task:task};};
      queueRunAfterActive('First command'); queueRunAfterActive('Second command');
    ` });
    assert.equal(await page.locator(".queued-command").count(), 2);
    assert.equal(await page.evaluate(() => (window as any).calls.includes("/api/stop")), false);
    await page.getByRole("button", { name: "Remove queued command" }).first().click();
    await page.waitForFunction(() => document.querySelectorAll('.queued-command').length === 1);
    assert.equal(await page.locator(".queued-command-text").innerText(), "Second command");
    await page.evaluate(() => (window as any).queueRunAfterActive("Updated instruction"));
    await page.getByRole("button", { name: "↳ Steer" }).last().click();
    await page.waitForFunction(() => !(window as any).steeringInFlight);
    assert.match(await page.locator(".queued-command-text").first().innerText(), /Updated instruction/);
    assert.equal(await page.evaluate(() => (window as any).calls.filter((url: string) => url.startsWith("/api/stop")).length), 1);
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

test("background updates keep the composer focused while deliberate inputs remain usable", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<textarea id='prompt'></textarea><button id='send-button'>Send</button><button id='auto-approve-toggle' class='composer-action'>Shield</button><button data-agent-engine='cheap'>Economy</button><input id='other'><div id='browser-viewport'><input id='browser-input'></div><dialog id='modal'><input></dialog>");
    await page.addScriptTag({ content: readFileSync(join(__dirname, "../static/browserRuntime.js"), "utf8") });
    await page.addScriptTag({ content: `var prompt=document.getElementById('prompt'),browserViewport=document.getElementById('browser-viewport');${source("focusComposer", "\n  function startRun")}` });
    await page.locator("#prompt").focus();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    assert.equal(await page.locator("#prompt").evaluate(element => element === document.activeElement), true);
    await page.locator("#prompt").fill("Keep this draft");
    for (const label of ["Shield", "Economy"]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      assert.equal(await page.locator("#prompt").evaluate(element => element === document.activeElement), true);
      await page.getByRole("button", { name: label, exact: true }).focus();
      await page.evaluate(() => (window as any).focusComposer());
      assert.equal(await page.locator("#prompt").evaluate(element => element === document.activeElement), true);
    }
    assert.equal(await page.locator("#prompt").inputValue(), "Keep this draft");
    await page.locator("#other").focus();
    await page.evaluate(() => (window as any).focusComposer());
    assert.equal(await page.locator("#other").evaluate(element => element === document.activeElement), true);
    await page.locator("#browser-input").focus();
    await page.evaluate(() => (window as any).focusComposer());
    assert.equal(await page.locator("#browser-input").evaluate(element => element === document.activeElement), true);
    await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).showModal());
    await page.evaluate(() => (window as any).focusComposer());
    assert.equal(await page.locator("#modal input").evaluate(element => element === document.activeElement), true);
  } finally { await browser.close(); }
});


test("one composer action switches between stop and follow-up send without losing drafts", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<textarea id='prompt'></textarea><button id='stop-run-btn' hidden>Header stop</button><button id='composer-stop-button' hidden>Stop</button><button id='send-button'>Send</button>");
    await page.addScriptTag({ content: `
      var prompt=document.getElementById('prompt'), stopRunBtn=document.getElementById('stop-run-btn'), sendButton=document.getElementById('send-button');
      var attachments=[], taggedDiscussionBots=[];
      ${source("syncComposerAction", "\n  function setStatusState")}
      prompt.addEventListener('input',syncComposerAction);
      syncComposerAction();
    ` });
    assert.equal(await page.locator("#send-button").isVisible(), true);
    await page.evaluate(() => { (document.getElementById("stop-run-btn") as HTMLElement).hidden = false; (window as any).syncComposerAction(); });
    assert.equal(await page.locator("#composer-stop-button").isVisible(), true);
    assert.equal(await page.locator("#send-button").isVisible(), false);
    await page.locator("#prompt").fill("Change direction");
    assert.equal(await page.locator("#composer-stop-button").isVisible(), false);
    assert.equal(await page.getByRole("button", {name: "Send follow-up message"}).isVisible(), true);
    await page.evaluate(() => { (document.getElementById("stop-run-btn") as HTMLElement).hidden = true; (window as any).syncComposerAction(); });
    assert.equal(await page.locator("#prompt").inputValue(), "Change direction");
    assert.equal(await page.getByRole("button", {name: "Send message"}).isVisible(), true);
    await page.locator("#prompt").fill("");
    assert.equal(await page.locator("#composer-stop-button").isVisible(), false);
    assert.equal(await page.locator("#send-button").isVisible(), true);
  } finally { await browser.close(); }
});
