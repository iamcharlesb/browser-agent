const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function load() {
  const state = { fetchImpl: async function() { throw new Error("fetch not stubbed"); } };
  const window = { location: { href: "http://127.0.0.1:8765/", origin: "http://127.0.0.1:8765" } };
  const sandbox = {
    window,
    location: window.location,
    URL,
    AbortController,
    fetch: function() { return state.fetchImpl.apply(this, arguments); },
    document: {
      createElement: function(tag) {
        return {
          tagName: String(tag).toUpperCase(),
          className: "",
          innerHTML: "",
          textContent: "",
          src: "",
          alt: "",
          title: "",
          srcdoc: "",
          setAttribute: function() {},
          querySelectorAll: function() { return []; },
          appendChild: function() {},
          replaceWith: function() {}
        };
      }
    },
    Object,
    TypeError
  };
  vm.runInNewContext(readFileSync(join(__dirname, "../static/artifactPreview.js"), "utf8"), sandbox);
  return { api: sandbox.window.PiloArtifacts, state: state };
}

test("artifactUrl accepts same-origin artifact paths only", () => {
  const { api } = load();
  assert.equal(api.artifactUrl("/api/artifacts/ticket.html").pathname, "/api/artifacts/ticket.html");
  assert.equal(api.artifactUrl("sandbox:/api/artifacts/ticket.html").pathname, "/api/artifacts/ticket.html");
  assert.equal(api.artifactUrl("https://example.com/api/artifacts/ticket.html"), null);
  assert.equal(api.artifactUrl("/api/artifacts/nested/ticket.html"), null);
  assert.equal(api.artifactUrl("javascript:alert(1)"), null);
});

test("createViewer loads preview metadata and prepares download", async () => {
  const { api, state } = load();
  const title = { textContent: "" };
  const body = {
    textContent: "",
    replaceChildren: function() { this.children = []; this.textContent = ""; },
    appendChild: function(child) { this.children = this.children || []; this.children.push(child); this.textContent = ""; },
    children: []
  };
  const download = { href: "" };
  let opened = 0;
  state.fetchImpl = async function(url) {
    assert.match(String(url), /\?preview=1$/);
    return {
      ok: true,
      async json() {
        return { kind: "html", filename: "ticket.html", text: "<h1>Hello</h1>", url: "/api/artifacts/ticket.html" };
      }
    };
  };
  const viewer = api.createViewer({
    title: title,
    body: body,
    download: download,
    formatMarkdown: function(text) { return text; },
    onOpen: function() { opened += 1; }
  });
  assert.equal(await viewer.open("/api/artifacts/ticket.html"), true);
  assert.equal(opened, 1);
  assert.equal(title.textContent, "ticket.html");
  assert.match(download.href, /\/api\/artifacts\/ticket\.html\?download=1$/);
  assert.equal(body.children[0].tagName, "IFRAME");
});
