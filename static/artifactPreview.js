(function(global) {
  "use strict";
  function artifactUrl(value) {
    try {
      var url = new URL(String(value).replace(/^sandbox:/, ""), location.href);
      return url.origin === location.origin && /^\/api\/artifacts\/[^/]+$/.test(url.pathname) ? url : null;
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
        if (data.kind === "markdown") {
          element = document.createElement("article");
          element.className = "artifact-markdown";
          element.innerHTML = options.formatMarkdown(data.text);
          // Documents cannot silently load remote tracking images.
          element.querySelectorAll("img").forEach(function(img) { if (!artifactUrl(img.getAttribute("src"))) img.replaceWith(document.createTextNode(img.alt || "External image")); });
        } else if (data.kind === "text") {
          element = document.createElement("pre"); element.textContent = data.text;
        } else if (data.kind === "image") {
          element = document.createElement("img"); element.src = data.url; element.alt = data.filename;
        } else if (data.kind === "html" || data.kind === "pdf") {
          element = document.createElement("iframe"); element.title = data.filename;
          element.setAttribute("sandbox", "");
          if (data.kind === "html") element.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">' + data.text;
          else element.src = data.url;
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
