const test = require("node:test");
const assert = require("node:assert/strict");
const { getExternalGoogleSignInAppUrl, buildDesktopGoogleSignInUrl } = require("./googleSignIn");

test("routes Electron GIS popup requests to the local app sign-in page", () => {
  const request = "https://accounts.google.com/gsi/select?client_id=test.apps.googleusercontent.com&origin=http%3A%2F%2F127.0.0.1%3A8765";
  assert.equal(
    getExternalGoogleSignInAppUrl(request, "http://127.0.0.1:8765"),
    "http://127.0.0.1:8765/?googleSignIn=external"
  );
});

test("desktop sign-in opens the local app with a validated one-time handoff", () => {
  const nonce = "a".repeat(48);
  const verifier = "b".repeat(64);
  const url = new URL(buildDesktopGoogleSignInUrl(8765, nonce, verifier));
  assert.equal(url.origin, "http://127.0.0.1:8765");
  assert.equal(url.searchParams.get("googleSignIn"), "external");
  assert.equal(url.searchParams.get("state"), nonce);
  assert.equal(url.searchParams.has("verifier"), false);
  assert.equal(buildDesktopGoogleSignInUrl(0, nonce), null);
  assert.equal(buildDesktopGoogleSignInUrl(8765, "bad"), null);
});

test("does not rewrite unrelated popups or requests from another origin", () => {
  assert.equal(getExternalGoogleSignInAppUrl("https://accounts.google.com/ServiceLogin", "http://127.0.0.1:8765"), null);
  assert.equal(
    getExternalGoogleSignInAppUrl("https://accounts.google.com/gsi/select?client_id=x&origin=https%3A%2F%2Fevil.example", "http://127.0.0.1:8765"),
    null
  );
  assert.equal(
    getExternalGoogleSignInAppUrl("https://accounts.google.com/gsi/select?client_id=x&origin=https%3A%2F%2Fapp.example", "https://app.example"),
    null
  );
});
