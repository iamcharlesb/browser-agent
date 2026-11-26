(function(global) {
  "use strict";
  function artifactUrl(value) {
    try {
      var raw = String(value || "").trim().replace(/^sandbox:\s*/, "");
      if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//i.test(raw)) raw = "http://" + raw;
      var url = new URL(raw, location.href);
      var loopback = function(host) { return ["localhost", "127.0.0.1", "[::1]"].indexOf(host.toLowerCase()) >= 0; };
      var match = /^\/(?:api\/)?artifacts\/([^/]+)$/.exec(url.pathname);
      if (!match || url.username || url.password || !/^https?:$/.test(url.protocol)) return null;
      if (url.origin !== location.origin && !(loopback(url.hostname) && loopback(new URL(location.href).hostname))) return null;
      var filename = decodeURIComponent(match[1]);
      if (!filename || /[\/\\]/.test(filename) || filename === "." || filename === "..") return null;
      // Saved links can refer to a previous local port; files belong to the current workspace.
      return new URL("/api/artifacts/" + encodeURIComponent(filename), location.href);
    } catch (_) { return null; }
  }
  function createViewer(options) {
    var sequence = 0, controller = null;
    async function open(value) {
      var url = artifactUrl(value);
      if (!url) return false;
      var request = ++sequence;
      if (controller) controller.abort();
      controller = new AbortController();
      options.onOpen();
      options.title.textContent = decodeURIComponent(url.pathname.split("/").pop());
      options.title.title = options.title.textContent;
      options.body.replaceChildren();
      options.body.textContent = "Loading preview…";
      var download = new URL(url); download.search = "?download=1";
      options.download.href = download.href;
      url.search = "?preview=1";
      try {
        var response = await fetch(url.href, { signal: controller.signal });
        var data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Could not open this file.");
        if (request !== sequence) return true;
        options.body.replaceChildren();
        var element;
        var resource = artifactUrl(data.url || value) || artifactUrl(value);
        if (data.kind === "markdown") {
          element = document.createElement("article");
          element.className = "artifact-markdown";
          element.innerHTML = options.formatMarkdown(data.text);
          // Documents cannot silently load remote tracking images.
          element.querySelectorAll("img").forEach(function(img) {
            var image = artifactUrl(img.getAttribute("src"));
            if (image) img.src = image.href;
            else img.replaceWith(document.createTextNode(img.alt || "External image"));
          });
        } else if (data.kind === "text") {
          element = document.createElement("pre"); element.textContent = data.text;
        } else if (data.kind === "image") {
          element = document.createElement("img"); element.src = resource.href; element.alt = data.filename;
        } else if (data.kind === "video") {
          element = document.createElement("video"); element.src = resource.href; element.controls = true; element.preload = "metadata"; element.style.width = "100%";
        } else if (data.kind === "html" || data.kind === "pdf") {
          element = document.createElement("iframe"); element.title = data.filename;
          element.setAttribute("sandbox", "");
          if (data.kind === "html") element.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">' + data.text;
          else element.src = resource.href;
        } else {
          element = document.createElement("p"); element.textContent = data.note || "A preview is not available for this format. Use Download to open the file.";
        }
        options.body.appendChild(element);
      } catch (error) {
        if (request === sequence && error.name !== "AbortError") options.body.textContent = error.message || "Preview unavailable. You can still download the file.";
      }
      return true;
    }
    return { open: open, cancel: function() { sequence++; if (controller) controller.abort(); } };
  }
  global.PiloArtifacts = { artifactUrl: artifactUrl, createViewer: createViewer };
})(typeof window === "undefined" ? globalThis : window);
