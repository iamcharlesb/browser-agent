import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envInteger } from "./runtimeConfig";

export interface BrowserProfile { id: string; name: string; port?: number }
/** Browser cookies only: these profiles do not change bot history or application sign-in. */
export class BrowserProfiles {
  private state: { activeId: string; profiles: BrowserProfile[] };
  private file: string;
  constructor(private root: string) {
    this.file = join(root, "profiles.json");
    try { this.state = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { activeId: "default", profiles: [{ id: "default", name: "Default" }] };
    }
    if (!Array.isArray(this.state.profiles) || !this.state.profiles.length || this.state.profiles.some(profile =>
      !profile || !/^(?:default|[0-9a-f-]{36})$/.test(profile.id) || typeof profile.name !== "string" ||
      (profile.id !== "default" && (!Number.isInteger(profile.port) || profile.port! < 1024 || profile.port! > 65535)))) throw new Error("Invalid browser profile registry; preserve the profile data and repair profiles.json.");
    this.active();
  }
  list() { return structuredClone(this.state); }
  active() { const profile = this.state.profiles.find(item => item.id === this.state.activeId); if (!profile) throw new Error("Unknown active browser profile."); return { ...profile }; }
  directory(id: string) { if (!this.state.profiles.some(item => item.id === id)) throw new Error("Unknown browser profile."); return join(this.root, id); }
  create(name: unknown) {
    if (typeof name !== "string" || !name.trim() || name.length > 60 || /[\x00-\x1f]/.test(name)) throw new Error("Use a profile name of 1–60 characters.");
    if (this.state.profiles.some(item => item.name.toLowerCase() === name.trim().toLowerCase())) throw new Error("That profile name already exists.");
    if (this.state.profiles.length >= envInteger("BROWSER_AGENT_MAX_BROWSER_PROFILES", 20, 2, 100)) throw new Error("Browser profile limit reached.");
    const port = envInteger("BROWSER_AGENT_PROFILE_PORT_BASE", 9400, 1024, 65000) + this.state.profiles.length - 1;
    const profile = { id: randomUUID(), name: name.trim(), port };
    this.save({ ...this.state, profiles: [...this.state.profiles, profile] }); return profile;
  }
  select(id: unknown) { if (!this.state.profiles.some(item => item.id === id)) throw new Error("Unknown browser profile."); this.save({ ...this.state, activeId: String(id) }); }
  private save(state: typeof this.state) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileSync(this.file + ".tmp", JSON.stringify(state), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file); this.state = state;
  }
}
