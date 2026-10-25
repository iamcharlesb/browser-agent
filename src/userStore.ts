import { redactSecrets } from "./security";
/**
 * Persistent identity + prefs for Google-signed-in users.
 *
 * Backend priority:
 * 1. MongoDB when MONGODB_URI is set (Atlas or any Mongo)
 * 2. Local JSON under .browser-agent-users/ (no Atlas required)
 *
 * Guest explorers never hit this store — they stay on localStorage only.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MongoClient, type Db, type Collection, type ChangeStream } from "mongodb";

export type AuthBackend = "mongodb" | "local" | "none";

export interface GoogleUserProfile {
  googleSub: string;
  email: string;
  name: string;
  picture: string | null;
}

export interface UserSettings {
  interactionMode?: string;
  sessionMode?: string;
  model?: string;
  autoApprove?: boolean;
  [key: string]: unknown;
}

/** Bot roster entries as stored by the UI (opaque JSON objects). */
/** Deletion markers survive stale clients writing an older roster. */
export function preserveBotDeletions(existing: BotRosterEntry[], incoming: BotRosterEntry[]): BotRosterEntry[] {
  const deleted = new Map<string, BotRosterEntry>();
  for (const bot of [...existing, ...incoming]) {
    if (bot.deleted === true && typeof bot.id === "string") deleted.set(bot.id, { id: bot.id, deleted: true });
  }
  return [...incoming.filter(bot => !deleted.has(String(bot.id))), ...deleted.values()];
}

export type BotRosterEntry = Record<string, unknown>;

export interface PersistedUserRecord {
  googleSub: string;
  email: string;
  name: string;
  picture: string | null;
  bots: BotRosterEntry[];
  settings: UserSettings;
  createdAt: string;
  updatedAt: string;
}

const USERS_DIR_NAME = ".browser-agent-users";
const DEFAULT_DB_NAME = "openbots";
const USERS_COLLECTION = "users";

let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;
let mongoInitPromise: Promise<Db | null> | null = null;
let indexesEnsured = false;

// One database cursor per process; notifications contain no user content.
const userChangeListeners = new Map<string, Set<() => void>>();
let userChangeStream: ChangeStream<PersistedUserRecord> | null = null;
let userChangeRetry: ReturnType<typeof setTimeout> | null = null;
let userChangeStarting: Promise<void> | null = null;

function notifyUserChanged(googleSub: string): void {
  for (const listener of userChangeListeners.get(googleSub) ?? []) listener();
}

async function ensureUserChangeStream(): Promise<void> {
  if (userChangeStream || userChangeStarting || !mongodbConfigured() || !userChangeListeners.size) return;
  userChangeStarting = (async () => {
    const db = await connectMongo();
    if (!db || !userChangeListeners.size) return;
    const stream = usersCollection(db).watch([], { fullDocument: "updateLookup", maxAwaitTimeMS: 1000 });
    userChangeStream = stream;
    stream.on("change", change => {
      if ("fullDocument" in change && change.fullDocument) {
        notifyUserChanged(change.fullDocument.googleSub);
      } else {
        // Deletes and collection invalidation do not include a user identity.
        for (const googleSub of userChangeListeners.keys()) notifyUserChanged(googleSub);
      }
    });
    stream.on("error", () => {
      if (userChangeStream !== stream) return;
      userChangeStream = null;
      void stream.close().catch(() => undefined);
      scheduleUserChangeRetry();
    });
    stream.on("close", () => {
      if (userChangeStream === stream) {
        userChangeStream = null;
        scheduleUserChangeRetry();
      }
    });
    // Reconcile changes missed before opening/reopening the cursor.
    for (const googleSub of userChangeListeners.keys()) notifyUserChanged(googleSub);
  })().catch(() => undefined).finally(() => {
    userChangeStarting = null;
    if (!userChangeStream) scheduleUserChangeRetry();
  });
  await userChangeStarting;
}

function scheduleUserChangeRetry(): void {
  if (userChangeRetry || !userChangeListeners.size || !mongodbConfigured()) return;
  userChangeRetry = setTimeout(() => {
    userChangeRetry = null;
    void ensureUserChangeStream();
  }, 15_000);
  userChangeRetry.unref();
}

/** Call before loading the initial snapshot so concurrent changes are observed. */
export function subscribeUserChanges(googleSub: string, listener: () => void): () => void {
  const listeners = userChangeListeners.get(googleSub) ?? new Set<() => void>();
  listeners.add(listener);
  userChangeListeners.set(googleSub, listeners);
  void ensureUserChangeStream();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) userChangeListeners.delete(googleSub);
    if (!userChangeListeners.size) {
      if (userChangeRetry) clearTimeout(userChangeRetry);
      userChangeRetry = null;
      const stream = userChangeStream;
      userChangeStream = null;
      if (stream) void stream.close().catch(() => undefined);
    }
  };
}

function usersDir(repoRoot: string): string {
  return join(repoRoot, USERS_DIR_NAME);
}

function userFilePath(repoRoot: string, googleSub: string): string {
  const safe = googleSub.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return join(usersDir(repoRoot), `${safe}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyRecord(profile: GoogleUserProfile): PersistedUserRecord {
  const stamp = nowIso();
  return {
    googleSub: profile.googleSub,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
    bots: [],
    settings: {},
    createdAt: stamp,
    updatedAt: stamp
  };
}

function normalizeRecord(raw: unknown, fallback: GoogleUserProfile): PersistedUserRecord {
  const base = emptyRecord(fallback);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const doc = raw as Record<string, unknown>;
  const bots = Array.isArray(doc.bots)
    ? doc.bots.filter((b): b is BotRosterEntry => Boolean(b) && typeof b === "object" && !Array.isArray(b))
    : [];
  const settings =
    doc.settings && typeof doc.settings === "object" && !Array.isArray(doc.settings)
      ? (doc.settings as UserSettings)
      : {};
  return {
    googleSub: typeof doc.googleSub === "string" ? doc.googleSub : fallback.googleSub,
    email: typeof doc.email === "string" ? doc.email : fallback.email,
    name: typeof doc.name === "string" ? doc.name : fallback.name,
    picture: typeof doc.picture === "string" ? doc.picture : doc.picture === null ? null : fallback.picture,
    bots,
    settings,
    createdAt: typeof doc.createdAt === "string" ? doc.createdAt : base.createdAt,
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : base.updatedAt
  };
}

export function resolveAuthBackend(): AuthBackend {
  if (process.env.MONGODB_URI?.trim()) return "mongodb";
  return "local";
}

export function mongodbConfigured(): boolean {
  return Boolean(process.env.MONGODB_URI?.trim());
}

async function connectMongo(): Promise<Db | null> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) return null;
  if (mongoDb) return mongoDb;
  if (mongoInitPromise) return mongoInitPromise;

  mongoInitPromise = (async () => {
    try {
      const client = new MongoClient(uri, {
        maxPoolSize: 4,
        serverSelectionTimeoutMS: 8_000,
        connectTimeoutMS: 8_000
      });
      await client.connect();
      const dbName = process.env.MONGODB_DB?.trim() || DEFAULT_DB_NAME;
      const db = client.db(dbName);
      mongoClient = client;
      mongoDb = db;
      if (!indexesEnsured) {
        const users = db.collection(USERS_COLLECTION);
        await users.createIndex({ googleSub: 1 }, { unique: true });
        await users.createIndex({ email: 1 });
        indexesEnsured = true;
      }
      return db;
    } catch (error) {
      console.warn(
        "[openbots] MongoDB unavailable; falling back to local user files.",
        redactSecrets(error instanceof Error ? error.message : String(error))
      );
      mongoClient = null;
      mongoDb = null;
      return null;
    } finally {
      // Allow retry on next call if connect failed.
      if (!mongoDb) mongoInitPromise = null;
    }
  })();

  return mongoInitPromise;
}

function usersCollection(db: Db): Collection<PersistedUserRecord> {
  return db.collection<PersistedUserRecord>(USERS_COLLECTION);
}

async function readLocalUser(repoRoot: string, profile: GoogleUserProfile): Promise<PersistedUserRecord | null> {
  try {
    const raw = await readFile(userFilePath(repoRoot, profile.googleSub), "utf8");
    return normalizeRecord(JSON.parse(raw), profile);
  } catch {
    return null;
  }
}

async function writeLocalUser(repoRoot: string, record: PersistedUserRecord): Promise<void> {
  const dir = usersDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const target = userFilePath(repoRoot, record.googleSub);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2), "utf8");
  try {
    await rename(temp, target);
  } catch {
    await writeFile(target, JSON.stringify(record, null, 2), "utf8");
    await unlink(temp).catch(() => undefined);
  }
}

/** Upsert Google profile; preserve existing bots/settings. */
export async function upsertGoogleUser(
  repoRoot: string,
  profile: GoogleUserProfile
): Promise<{ user: PersistedUserRecord; backend: AuthBackend }> {
  const stamp = nowIso();
  const db = await connectMongo();

  if (db) {
    const col = usersCollection(db);
    const existing = await col.findOne({ googleSub: profile.googleSub });
    const next: PersistedUserRecord = existing
      ? {
          ...normalizeRecord(existing, profile),
          email: profile.email,
          name: profile.name,
          picture: profile.picture,
          updatedAt: stamp
        }
      : { ...emptyRecord(profile), updatedAt: stamp };
    // createdAt must only appear in $setOnInsert — Mongo rejects the same path in $set + $setOnInsert.
    const { createdAt, ...setFields } = next;
    await col.updateOne(
      { googleSub: profile.googleSub },
      { $set: setFields, $setOnInsert: { createdAt } },
      { upsert: true }
    );
    return { user: next, backend: "mongodb" };
  }

  const existing = await readLocalUser(repoRoot, profile);
  const next: PersistedUserRecord = existing
    ? {
        ...existing,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        updatedAt: stamp
      }
    : emptyRecord(profile);
  await writeLocalUser(repoRoot, next);
  notifyUserChanged(next.googleSub);
  return { user: next, backend: "local" };
}

export async function getUserByGoogleSub(
  repoRoot: string,
  googleSub: string,
  hint?: Partial<GoogleUserProfile>
): Promise<{ user: PersistedUserRecord | null; backend: AuthBackend }> {
  const profile: GoogleUserProfile = {
    googleSub,
    email: hint?.email ?? "",
    name: hint?.name ?? "Google user",
    picture: hint?.picture ?? null
  };
  const db = await connectMongo();
  if (db) {
    const doc = await usersCollection(db).findOne({ googleSub });
    return { user: doc ? normalizeRecord(doc, profile) : null, backend: "mongodb" };
  }
  return { user: await readLocalUser(repoRoot, profile), backend: "local" };
}

export async function saveUserBotsAndSettings(
  repoRoot: string,
  googleSub: string,
  data: { bots?: BotRosterEntry[]; settings?: UserSettings },
  profileHint?: Partial<GoogleUserProfile>
): Promise<{ user: PersistedUserRecord; backend: AuthBackend }> {
  const stamp = nowIso();
  const hint: GoogleUserProfile = {
    googleSub,
    email: profileHint?.email ?? "",
    name: profileHint?.name ?? "Google user",
    picture: profileHint?.picture ?? null
  };

  const db = await connectMongo();
  if (db) {
    const col = usersCollection(db);
    const existing = await col.findOne({ googleSub });
    const base = existing ? normalizeRecord(existing, hint) : emptyRecord(hint);
    const next: PersistedUserRecord = {
      ...base,
      bots: data.bots !== undefined ? preserveBotDeletions(base.bots, data.bots) : base.bots,
      settings: data.settings !== undefined ? { ...base.settings, ...data.settings } : base.settings,
      updatedAt: stamp
    };
    await col.updateOne({ googleSub }, { $set: next }, { upsert: true });
    return { user: next, backend: "mongodb" };
  }

  const existing = await readLocalUser(repoRoot, hint);
  const base = existing ?? emptyRecord(hint);
  const next: PersistedUserRecord = {
    ...base,
    bots: data.bots !== undefined ? preserveBotDeletions(base.bots, data.bots) : base.bots,
    settings: data.settings !== undefined ? { ...base.settings, ...data.settings } : base.settings,
    updatedAt: stamp
  };
  await writeLocalUser(repoRoot, next);
  notifyUserChanged(next.googleSub);
  return { user: next, backend: "local" };
}

/** Test helper: drop in-memory Mongo handles so the next call re-reads env. */
export async function resetUserStoreForTests(): Promise<void> {
  userChangeListeners.clear();
  if (userChangeRetry) clearTimeout(userChangeRetry);
  userChangeRetry = null;
  const stream = userChangeStream;
  userChangeStream = null;
  if (stream) await stream.close().catch(() => undefined);
  if (mongoClient) {
    await mongoClient.close().catch(() => undefined);
  }
  mongoClient = null;
  mongoDb = null;
  mongoInitPromise = null;
  indexesEnsured = false;
}

export const USER_STORE_DEFAULT_DB = DEFAULT_DB_NAME;
export const USER_STORE_DIR_NAME = USERS_DIR_NAME;

/** Server-only shared connection; no URI or credentials are returned to clients. */
export { connectMongo as sharedMongoDatabase };

export { resetUserStoreForTests as closeUserStoreConnections };
