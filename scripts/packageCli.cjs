#!/usr/bin/env node
/** Explicit allowlist: never package the repository or private runtime state wholesale. */
const { mkdtempSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync, rmSync, chmodSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = resolve(__dirname, "..");
const version = process.env.PILO_CLI_VERSION || process.env.OPENBUDDY_CLI_VERSION || "0.1.0-preview.1";
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw new Error("Invalid PILO_CLI_VERSION.");
const output = resolve(process.env.PILO_CLI_RELEASE_DIR || process.env.OPENBUDDY_CLI_RELEASE_DIR || join(root, "release"));
const temporary = mkdtempSync(join(tmpdir(), "pilo-cli-package-"));
const stage = join(temporary, "package");
mkdirSync(join(stage, "dist"), { recursive: true });
mkdirSync(output, { recursive: true });
try {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json"), "--outDir", join(temporary, "compiled")], { cwd: root, stdio: "inherit" });
  for (const file of readdirSync(join(temporary, "compiled"))) {
    if (file.endsWith(".js") && !file.endsWith(".test.js")) cpSync(join(temporary, "compiled", file), join(stage, "dist", file));
  }
  for (const entry of ["static", "agents", "playbooks", "docs", "AGENTS.md", "soul.md"]) cpSync(join(root, entry), join(stage, entry), { recursive: true, dereference: false });
  cpSync(join(root, "README.md"), join(stage, "docs/runtime-setup.md"));
  cpSync(join(root, "docs/cli.md"), join(stage, "README.md"));
  const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const dependencies = Object.fromEntries(Object.keys(source.dependencies).map(name => [name, lock.packages["node_modules/" + name].version]));
  const manifest = {
    name: "@iamcharlesb/pilo-cli", version, private: true,
    description: "Pilo local agent CLI preview", license: "UNLICENSED",
    bin: { pilo: "dist/piloCli.js" }, engines: { node: ">=22.0.0" },
    repository: { type: "git", url: "https://github.com/iamcharlesb/browser-agent.git" },
    files: ["dist", "static", "agents", "playbooks", "docs", "AGENTS.md", "soul.md", "README.md", "npm-shrinkwrap.json"], dependencies
  };
  writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  // A shrinkwrap preserves the tested transitive dependency graph for tarball installs.
  lock.name = manifest.name; lock.version = version;
  lock.packages[""] = { name: manifest.name, version, dependencies, engines: manifest.engines, bin: manifest.bin };
  writeFileSync(join(stage, "npm-shrinkwrap.json"), JSON.stringify(lock, null, 2) + "\n");
  chmodSync(join(stage, "dist/piloCli.js"), 0o755);
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--cache", join(temporary, "cache"), "--pack-destination", output], { cwd: stage, encoding: "utf8" }))[0];
  const digest = createHash("sha256").update(readFileSync(join(output, packed.filename))).digest("hex");
  writeFileSync(join(output, packed.filename + ".sha256"), `${digest}  ${packed.filename}\n`);
  console.log(JSON.stringify({ file: join(output, packed.filename), sha256: digest, files: packed.files.length }, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
