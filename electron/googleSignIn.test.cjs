const test = require("node:test");
const assert = require("node:assert/strict");
const { getExternalGoogleSignInAppUrl } = require("./googleSignIn");

test("routes Electron GIS popup requests to the local app sign-in page", () => {
  const request = "https://accounts.google.com/gsi/select?client_id=test.apps.googleusercontent.com&origin=http%3A%2F%2F127.0.0.1%3A8765";
  assert.equal(
    getExternalGoogleSignInAppUrl(request, "http://127.0.0.1:8765"),
    "http://127.0.0.1:8765/?googleSignIn=external"
  );
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
