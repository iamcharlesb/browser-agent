/** Build a named macOS shell from the installed Electron runtime. No app data is moved. */
const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { execFileSync } = require("node:child_process");

function desktopExecutable() {
  const electron = require("electron");
  if (process.platform !== "darwin") return electron;
  const root = join(__dirname, "..");
  const generated = join(root, ".desktop");
  const bundle = join(generated, "Pilo.app");
  const stampFile = join(generated, "runtime.json");
  const stamp = JSON.stringify({ version: require("electron/package.json").version, branding: 2, source: electron });
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp && existsSync(join(bundle, "Contents/MacOS/Electron"))) return join(bundle, "Contents/MacOS/Electron");
  mkdirSync(generated, { recursive: true });
  // Only replace a bundle created by this launcher.
  if (existsSync(bundle)) {
    if (!existsSync(stampFile)) throw new Error("The generated Pilo.app folder already exists without a runtime marker. Rename it before launching.");
    rmSync(bundle, { recursive: true });
  }
  writeFileSync(stampFile, "building", { mode: 0o600 });
  cpSync(dirname(dirname(dirname(electron))), bundle, { recursive: true, verbatimSymlinks: true });
  const plist = join(bundle, "Contents/Info.plist");
  for (const [key, value] of [["CFBundleName", "Pilo"], ["CFBundleDisplayName", "Pilo"], ["CFBundleIdentifier", "com.pilo.desktop"]]) {
    try { execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], { stdio: "pipe" }); }
    catch { execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist], { stdio: "pipe" }); }
  }
  // The plist update changes the vendor signature; re-sign this local development shell.
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "pipe" });
  writeFileSync(stampFile, stamp, { mode: 0o600 });
  return join(bundle, "Contents/MacOS/Electron");
}
module.exports = { desktopExecutable };
