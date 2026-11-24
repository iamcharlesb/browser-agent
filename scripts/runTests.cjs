/** Discover all compiled unit tests and the shipped desktop/UI suites. */
const { readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const root = resolve(__dirname, "..");
function discover(directory, suffix) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? discover(file, suffix) : entry.name.endsWith(suffix) ? [file] : [];
  });
}
const files = [...discover(".test-dist", ".test.js"), ...discover("electron", ".test.cjs"), ...discover("test", ".test.cjs")].sort();
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
