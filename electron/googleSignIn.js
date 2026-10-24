function getExternalGoogleSignInAppUrl(requestedUrl, appOrigin) {
  try {
    const request = new URL(requestedUrl);
    const app = new URL(appOrigin);
    if (request.origin !== "https://accounts.google.com" || request.pathname !== "/gsi/select") return null;
    if (request.searchParams.get("origin") !== app.origin || !request.searchParams.get("client_id")) return null;
    if (app.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(app.hostname)) return null;
    return `${app.origin}/?googleSignIn=external`;
  } catch {
    return null;
  }
}

function buildDesktopGoogleSignInUrl(port, nonce) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{48,128}$/i.test(nonce || "")) return null;
  const url = new URL(`http://127.0.0.1:${port}/`);
  url.searchParams.set("googleSignIn", "external");
  url.searchParams.set("state", nonce);
  return url.toString();
}

module.exports = { getExternalGoogleSignInAppUrl, buildDesktopGoogleSignInUrl };
