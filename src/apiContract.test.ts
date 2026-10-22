import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  artifactContentType,
  artifactUrlFor,
  isImageArtifactUrl,
  isRunInProgressMessage,
  resolveLoginDuringRun
} from "./apiContract";
import { titleRequiresHumanVerification } from "./browserController";

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
