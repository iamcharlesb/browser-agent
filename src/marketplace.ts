import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { environmentFilePath } from "./environment";
import { clearOutlookTokenCache } from "./outlookAddon";
import { persistEnvUpdates } from "./providerSettings";
import { DATA_ROOT } from "./runtimePaths";

export interface AddonConfigField {
  key: string;
  envVar: string;
  label: string;
  placeholder: string;
  helpText: string;
  secret: boolean;
  required?: boolean;
}

export interface MarketplaceAddonDefinition {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: "Communication" | "Productivity" | "Developer" | "Research";
  version: string;
  author: string;
  authType: "microsoft_graph" | "api_key" | "none";
  capabilities: string[];
  tools: string[];
  approvalNotes: string;
  setupSteps: string[];
  configFields: AddonConfigField[];
}

export interface InstalledAddonRecord {
  id: string;
  installed: boolean;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
}

export interface MarketplaceAddonStatus extends MarketplaceAddonDefinition {
  installed: boolean;
  enabled: boolean;
  installedAt?: string;
  updatedAt?: string;
  configured: boolean;
  configuredFields: Record<string, boolean>;
  publicConfig: Record<string, string>;
}

export const MARKETPLACE_CATALOG: readonly MarketplaceAddonDefinition[] = [
  {
    id: "outlook",
    name: "Microsoft Outlook",
    tagline: "Read, search, draft, and send Outlook mail & calendar events via Microsoft Graph.",
    description:
      "Connects Pilo bots to your Microsoft 365 or Outlook.com mailbox and calendar using the Microsoft Graph API. Reading messages, searching mail, listing events, and saving drafts run directly; sending or replying to emails always requires explicit approval.",
    category: "Communication",
    version: "1.0.0",
    author: "Pilo",
    authType: "microsoft_graph",
    capabilities: [
      "List and read inbox or folder messages",
      "Search emails by sender, subject, or keywords",
      "Create unsent email drafts in Drafts",
      "Send and reply to emails (approval-gated)",
      "List upcoming calendar events"
    ],
    tools: ["outlook"],
    approvalNotes: "Sending or replying to emails triggers an explicit outward-action approval prompt.",
    setupSteps: [
      "Open Microsoft Graph Explorer (https://developer.microsoft.com/graph/graph-explorer) or register an Entra ID app with Mail.Read, Mail.ReadWrite, Mail.Send, and Calendars.Read permissions.",
      "Copy your delegated access token into OUTLOOK_ACCESS_TOKEN (or configure Client ID + Refresh Token for automatic token refresh).",
      "Save configuration and click Test connection to verify your mailbox identity."
    ],
    configFields: [
      {
        key: "accessToken",
        envVar: "OUTLOOK_ACCESS_TOKEN",
        label: "Microsoft Graph Access Token",
        placeholder: "Paste delegated access token (stored in local .env)",
        helpText: "Required unless Refresh Token + Client ID are configured. Never exposed in API responses.",
        secret: true
      },
      {
        key: "tenantId",
        envVar: "OUTLOOK_TENANT_ID",
        label: "Tenant ID (optional)",
        placeholder: "common",
        helpText: "Use 'common' for personal + work accounts, 'consumers' for Outlook.com, or your Entra tenant GUID.",
        secret: false
      },
      {
        key: "clientId",
        envVar: "OUTLOOK_CLIENT_ID",
        label: "Application (Client) ID (optional)",
        placeholder: "00000000-0000-0000-0000-000000000000",
        helpText: "Needed only if using a Refresh Token for automatic access token renewal.",
        secret: false
      },
      {
        key: "refreshToken",
        envVar: "OUTLOOK_REFRESH_TOKEN",
        label: "OAuth Refresh Token (optional)",
        placeholder: "Paste OAuth refresh token",
        helpText: "Optional. Used with Client ID to automatically mint fresh Microsoft Graph access tokens.",
        secret: true
      },
      {
        key: "clientSecret",
        envVar: "OUTLOOK_CLIENT_SECRET",
        label: "Client Secret (optional)",
        placeholder: "Paste confidential client secret (if applicable)",
        helpText: "Only required for confidential web apps; leave blank for public/desktop apps.",
        secret: true
      }
    ]
  }
];

function defaultStateFile(): string {
  return process.env.BROWSER_AGENT_MARKETPLACE_FILE?.trim() || join(DATA_ROOT, ".browser-agent-marketplace.json");
}

function readStateMap(file: string): Record<string, InstalledAddonRecord> {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { addons?: Record<string, InstalledAddonRecord> };
    if (!raw || typeof raw !== "object" || !raw.addons || typeof raw.addons !== "object") return {};
    return raw.addons;
  } catch {
    return {};
  }
}

function writeStateMap(file: string, addons: Record<string, InstalledAddonRecord>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, addons }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export function getAddonDefinition(id: string): MarketplaceAddonDefinition | undefined {
  return MARKETPLACE_CATALOG.find((item) => item.id === id);
}

function isAddonConfigured(def: MarketplaceAddonDefinition, env: NodeJS.ProcessEnv): boolean {
  if (def.id === "outlook") {
    const hasAccess = Boolean(env.OUTLOOK_ACCESS_TOKEN?.trim());
    const hasRefresh = Boolean(env.OUTLOOK_REFRESH_TOKEN?.trim() && env.OUTLOOK_CLIENT_ID?.trim());
    return hasAccess || hasRefresh;
  }
  const requiredFields = def.configFields.filter((f) => f.required);
  if (!requiredFields.length) return true;
  return requiredFields.every((f) => Boolean(env[f.envVar]?.trim()));
}

export function listMarketplaceAddons(
  options?: { stateFile?: string; env?: NodeJS.ProcessEnv }
): MarketplaceAddonStatus[] {
  const file = options?.stateFile || defaultStateFile();
  const env = options?.env || process.env;
  const state = readStateMap(file);

  return MARKETPLACE_CATALOG.map((def) => {
    const rec = state[def.id];
    const configuredFields: Record<string, boolean> = {};
    const publicConfig: Record<string, string> = {};
    for (const field of def.configFields) {
      const val = env[field.envVar]?.trim() || "";
      configuredFields[field.key] = Boolean(val);
      if (!field.secret && val) {
        publicConfig[field.key] = val;
      }
    }
    return {
      ...def,
      installed: Boolean(rec?.installed),
      enabled: Boolean(rec?.installed && rec?.enabled),
      installedAt: rec?.installedAt,
      updatedAt: rec?.updatedAt,
      configured: isAddonConfigured(def, env),
      configuredFields,
      publicConfig
    };
  });
}

export function getMarketplaceAddon(
  id: string,
  options?: { stateFile?: string; env?: NodeJS.ProcessEnv }
): MarketplaceAddonStatus | undefined {
  return listMarketplaceAddons(options).find((item) => item.id === id);
}

export function isMarketplaceAddonEnabled(
  id: string,
  options?: { stateFile?: string }
): boolean {
  const file = options?.stateFile || defaultStateFile();
  const state = readStateMap(file);
  const rec = state[id];
  return Boolean(rec?.installed && rec?.enabled);
}

export function installMarketplaceAddon(
  id: string,
  options?: { stateFile?: string; env?: NodeJS.ProcessEnv }
): MarketplaceAddonStatus {
  const def = getAddonDefinition(id);
  if (!def) throw new Error(`Unknown marketplace addon: ${id}`);
  const file = options?.stateFile || defaultStateFile();
  const state = readStateMap(file);
  const now = new Date().toISOString();
  const existing = state[id];
  state[id] = {
    id,
    installed: true,
    enabled: true,
    installedAt: existing?.installedAt || now,
    updatedAt: now
  };
  writeStateMap(file, state);
  return getMarketplaceAddon(id, options)!;
}

export function uninstallMarketplaceAddon(
  id: string,
  options?: { stateFile?: string; env?: NodeJS.ProcessEnv }
): MarketplaceAddonStatus {
  const def = getAddonDefinition(id);
  if (!def) throw new Error(`Unknown marketplace addon: ${id}`);
  const file = options?.stateFile || defaultStateFile();
  const state = readStateMap(file);
  delete state[id];
  writeStateMap(file, state);
  if (id === "outlook") clearOutlookTokenCache();
  return getMarketplaceAddon(id, options)!;
}

export function toggleMarketplaceAddon(
  id: string,
  enabled: boolean,
  options?: { stateFile?: string; env?: NodeJS.ProcessEnv }
): MarketplaceAddonStatus {
  const def = getAddonDefinition(id);
  if (!def) throw new Error(`Unknown marketplace addon: ${id}`);
  const file = options?.stateFile || defaultStateFile();
  const state = readStateMap(file);
  const existing = state[id];
  if (!existing?.installed) {
    throw new Error(`Install ${def.name} before changing its enabled state.`);
  }
  state[id] = {
    ...existing,
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString()
  };
  writeStateMap(file, state);
  return getMarketplaceAddon(id, options)!;
}

export async function configureMarketplaceAddon(
  id: string,
  config: Record<string, unknown>,
  options?: { stateFile?: string; envFile?: string; env?: NodeJS.ProcessEnv }
): Promise<MarketplaceAddonStatus> {
  const def = getAddonDefinition(id);
  if (!def) throw new Error(`Unknown marketplace addon: ${id}`);
  const env = options?.env || process.env;
  const envFile = options?.envFile || environmentFilePath;
  const updates: Record<string, string | undefined> = {};

  for (const field of def.configFields) {
    if (!Object.hasOwn(config, field.key)) continue;
    const raw = config[field.key];
    if (raw === null) {
      updates[field.envVar] = undefined;
      continue;
    }
    if (typeof raw !== "string" || /[\r\n\0]/.test(raw)) {
      throw new Error(`${field.label} must be a single-line text value.`);
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      // Blank secret means "keep existing" unless explicitly cleared via null; blank non-secret clears.
      if (!field.secret) updates[field.envVar] = undefined;
      continue;
    }
    updates[field.envVar] = trimmed;
  }

  if (Object.keys(updates).length > 0) {
    await persistEnvUpdates(updates, envFile);
    for (const [variable, value] of Object.entries(updates)) {
      if (value === undefined) delete env[variable];
      else env[variable] = value;
    }
    if (id === "outlook") clearOutlookTokenCache();
  }

  return getMarketplaceAddon(id, { stateFile: options?.stateFile, env })!;
}
