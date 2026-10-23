import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  artifactContentType,
  artifactUrlFor,
  isImageArtifactUrl,
  isRunInProgressMessage,
  resolveLoginDuringRun
} from "./apiContract";
import { browserSessionConfig, DEFAULT_CHROME_PROFILE_DIR, DEFAULT_PROFILE_DIR, pageAccessDenied, titleRequiresHumanVerification } from "./browserController";

describe("saved Chrome session", () => {
  it("keeps attended login and task execution in visible Chrome with its own profile", () => {
    const config = browserSessionConfig("persistent", { headless: true });
    assert.equal(config.channel, "chrome");
    assert.equal(config.headless, false);
    assert.equal(config.userDataDir, DEFAULT_CHROME_PROFILE_DIR);
    assert.notEqual(config.userDataDir, DEFAULT_PROFILE_DIR);
    assert.equal(config.userAgent, undefined);
    assert.equal(config.guestMode, false);
  });
  it("keeps guest sessions ephemeral and unattended defaults headless", () => {
    const guest = browserSessionConfig("guest");
    assert.equal(guest.guestMode, true);
    assert.equal(guest.channel, undefined);
    assert.equal(browserSessionConfig("guest", { headless: false }).headless, false);
    const unattended = browserSessionConfig("persistent", { unattended: true });
    assert.equal(unattended.headless, true);
    assert.equal(unattended.channel, undefined);
  });
  it("recognizes denial pages without mistaking real challenges or articles for them", () => {
    assert.equal(pageAccessDenied("Attention Required! | Cloudflare", "Sorry, you have been blocked\nYou are unable to access medium.com"), true);
    assert.equal(pageAccessDenied("403 Forbidden", "Request refused"), true);
    assert.equal(pageAccessDenied("Just a moment...", "Verify you are human"), false);
    assert.equal(pageAccessDenied("How security works", "This article discusses why some requests receive access denied errors."), false);
  });
});

describe("apiContract artifacts", () => {
  it("maps image extensions to inline image MIME types", () => {
    assert.deepEqual(artifactContentType("shot.png"), { contentType: "image/png", inline: true });
    assert.deepEqual(artifactContentType("shot.JPG"), { contentType: "image/jpeg", inline: true });
    assert.deepEqual(artifactContentType("doc.pdf"), { contentType: "application/pdf", inline: true });
    assert.deepEqual(artifactContentType("bin.dat"), {
      contentType: "application/octet-stream",
      inline: false
    });
  });

  it("builds encoded artifact URLs and detects image URLs", () => {
    assert.equal(artifactUrlFor("image-1.png"), "/api/artifacts/image-1.png");
    assert.ok(isImageArtifactUrl("/api/artifacts/image-1.png"));
    assert.ok(!isImageArtifactUrl("/api/artifacts/notes.md"));
  });
});

describe("apiContract run/login busy handling", () => {
  it("reuses an active browser during a run instead of conflicting", () => {
    assert.equal(
      resolveLoginDuringRun({ runIsActive: true, hasActiveSession: true }),
      "reuse"
    );
    assert.equal(
      resolveLoginDuringRun({ runIsActive: true, hasActiveSession: true, modeChanged: true }),
      "busy"
    );
    assert.equal(
      resolveLoginDuringRun({ runIsActive: true, hasActiveSession: false }),
      "busy"
    );
    assert.equal(
      resolveLoginDuringRun({ runIsActive: false, hasActiveSession: false }),
      "open"
    );
  });

  it("detects both concurrent-run error phrasings", () => {
    assert.ok(isRunInProgressMessage("A task run is in progress. Wait for it to finish or stop it first."));
    assert.ok(isRunInProgressMessage("A run is already in progress. Wait for it to finish or stop it first."));
    assert.ok(!isRunInProgressMessage("No browser session is currently open."));
  });
});

describe("human verification title heuristics", () => {
  it("flags Reddit/Instagram-style captcha titles", () => {
    assert.ok(titleRequiresHumanVerification("Reddit - Prove your humanity"));
    assert.ok(titleRequiresHumanVerification("Just a moment..."));
    assert.ok(titleRequiresHumanVerification("Select all images with crosswalks"));
    assert.ok(!titleRequiresHumanVerification("Instagram"));
  });
});
