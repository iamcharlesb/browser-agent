import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  artifactContentType,
  artifactUrlFor,
  isImageArtifactUrl
} from "./apiContract";

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
