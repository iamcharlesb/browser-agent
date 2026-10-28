/* Traverse selected folders before reading files; never enter dependency/cache trees. */
(function(root) {
  "use strict";
  function allowed(path, config) {
    var parts = path.split("/"), name = parts[parts.length - 1].toLowerCase();
    return !parts.slice(0, -1).some(function(part) { return config.ignoredDirectories.indexOf(part.toLowerCase()) >= 0 || part.indexOf(".browser-agent-") === 0; }) &&
      !/^(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|credentials?(?:\.|$)|service[-_]account(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|ed25519)(?:\.|$))/.test(name) &&
      !/\.(?:pem|key|p12|pfx|keystore)$/.test(name) &&
      (["dockerfile", "makefile", "license", "licence", ".gitignore", ".dockerignore", ".editorconfig"].indexOf(name) >= 0 || config.sourceExtensions.indexOf(name.split(".").pop()) >= 0);
  }
  async function collect(directory, config) {
    if (config.ignoredDirectories.indexOf(directory.name.toLowerCase()) >= 0 || directory.name.indexOf(".browser-agent-") === 0) throw new Error("Choose a source project folder, not a dependency or cache directory.");
    var files = [], skippedDirectories = 0, bytes = 0;
    async function visit(handle, prefix) {
      for await (var entry of handle.values()) {
        var path = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.kind === "directory") {
          if (config.ignoredDirectories.indexOf(entry.name.toLowerCase()) >= 0 || entry.name.indexOf(".browser-agent-") === 0) { skippedDirectories++; continue; }
          await visit(entry, path);
        } else if (entry.kind === "file" && allowed(path, config)) {
          var file = await entry.getFile();
          if (file.size > config.maxFileBytes) continue;
          bytes += file.size;
          if (files.length >= config.maxFiles || bytes > config.maxProjectBytes) throw new Error("This project exceeds the source import limit. Select a smaller subfolder.");
          files.push({webkitRelativePath: directory.name + "/" + path, size: file.size, text: file.text.bind(file)});
        }
      }
    }
    await visit(directory, "");
    return {files: files, skippedDirectories: skippedDirectories};
  }
  var api = {allowed: allowed, collect: collect};
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OpenBuddyProjectScanner = api;
})(typeof window === "object" ? window : globalThis);
