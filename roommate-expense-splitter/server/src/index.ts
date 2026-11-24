import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { settleUp, Balance } from "./settleUp";

declare module "express-session" { interface SessionData { userId?: number } }
const app = express();
const port = Number(process.env.PORT ?? 3000);
const configuredSecret = process.env.SESSION_SECRET;
const secret = configuredSecret || randomBytes(32).toString("hex");
if (process.env.NODE_ENV === "production" && (!configuredSecret || configuredSecret.length < 32 || configuredSecret.startsWith("replace-this-"))) throw new Error("SESSION_SECRET must be at least 32 characters in production");

class SqliteSessionStore extends session.Store {
  get(sid: string, callback: (err: unknown, session?: session.SessionData | null) => void): void {
    try {
      const row = db.prepare("SELECT sess FROM sessions WHERE sid = ? AND expire > ?").get(sid, Date.now()) as { sess: string } | undefined;
      callback(null, row ? JSON.parse(row.sess) as session.SessionData : null);
    } catch (err) { callback(err); }
  }
  set(sid: string, value: session.SessionData, callback?: (err?: unknown) => void): void {
    try {
      const expires = value.cookie.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 7 * 86400000;
      db.prepare("INSERT INTO sessions(sid,sess,expire) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expire=excluded.expire")
        .run(sid, JSON.stringify(value), expires);
      callback?.();
    } catch (err) { callback?.(err); }
  }
  destroy(sid: string, callback?: (err?: unknown) => void): void {
    try { db.prepare("DELETE FROM sessions WHERE sid=?").run(sid); callback?.(); } catch (err) { callback?.(err); }
  }
  touch(sid: string, value: session.SessionData, callback?: (err?: unknown) => void): void { this.set(sid, value, callback); }
}

db.prepare("DELETE FROM sessions WHERE expire <= ?").run(Date.now());
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(session({
  name: "roommates.sid", secret, store: new SqliteSessionStore(), resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 7 * 86400000 }
}));
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.get("origin");
    if (origin) {
      try { if (new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "Cross-origin request blocked" }); }
      catch { return res.status(403).json({ error: "Invalid request origin" }); }
    }
  }
  next();
});

const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);
const idSchema = z.coerce.number().int().positive();
const userSchema = z.object({ name: z.string().trim().min(1).max(60), email: z.string().trim().email().max(254), password: z.string().min(10).max(72).refine(value => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 UTF-8 bytes") });
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(72).refine(value => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 UTF-8 bytes") });
const requireAuth = (req: Request, res: Response, next: NextFunction) => req.session.userId ? next() : res.status(401).json({ error: "Sign in required" });
const userById = db.prepare("SELECT id,name,email FROM users WHERE id=?");
const currentUser = (req: Request) => userById.get(req.session.userId!) as { id: number; name: string; email: string };
const membership = db.prepare("SELECT 1 FROM memberships WHERE group_id=? AND user_id=?");
function requireMembership(req: Request, res: Response, groupId: number): boolean {
  if (!membership.get(groupId, req.session.userId)) { res.status(404).json({ error: "Group not found" }); return false; }
  return true;
}
function centsFromDecimal(value: string): number {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.post("/api/auth/signup", asyncRoute(async (req, res) => {
  const parsed = userSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid signup details", details: parsed.error.flatten() });
  const { name, email, password } = parsed.data;
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users(email,name,password_hash) VALUES(?,?,?)").run(email.toLowerCase(), name, passwordHash);
    await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.userId = Number(result.lastInsertRowid);
    res.status(201).json({ user: currentUser(req) });
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) return res.status(409).json({ error: "An account with this email already exists" });
    throw err;
  }
}));
app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid login details" });
  const user = db.prepare("SELECT id,name,email,password_hash FROM users WHERE email=? COLLATE NOCASE").get(parsed.data.email) as { id: number; name: string; email: string; password_hash: string } | undefined;
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) return res.status(401).json({ error: "Email or password is incorrect" });
  await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = user.id;
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
}));
app.post("/api/auth/logout", requireAuth, (req, res, next) => req.session.destroy(err => {
  if (err) return next(err);
  res.clearCookie("roommates.sid", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production" });
  res.status(204).end();
}));
app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: currentUser(req) }));

app.get("/api/groups", requireAuth, (req, res) => {
  const groups = db.prepare(`SELECT g.id,g.name,g.invite_code AS inviteCode,
    (SELECT COUNT(*) FROM memberships m WHERE m.group_id=g.id) AS memberCount
    FROM groups g JOIN memberships mine ON mine.group_id=g.id WHERE mine.user_id=? ORDER BY g.id DESC`).all(req.session.userId);
  res.json({ groups });
});
app.post("/api/groups", requireAuth, (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Group name must be 1–80 characters" });
  const inviteCode = randomBytes(6).toString("hex").toUpperCase();
  const transaction = db.transaction(() => {
    const group = db.prepare("INSERT INTO groups(name,invite_code,created_by) VALUES(?,?,?)").run(parsed.data.name, inviteCode, req.session.userId);
    db.prepare("INSERT INTO memberships(group_id,user_id) VALUES(?,?)").run(group.lastInsertRowid, req.session.userId);
    return Number(group.lastInsertRowid);
  });
  const id = transaction();
  res.status(201).json({ group: { id, name: parsed.data.name, inviteCode, memberCount: 1 } });
});
app.post("/api/groups/join", requireAuth, (req, res) => {
  const parsed = z.object({ inviteCode: z.string().trim().length(12).regex(/^[A-Fa-f0-9]+$/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid 12-character invite code" });
  const group = db.prepare("SELECT id,name FROM groups WHERE invite_code=?").get(parsed.data.inviteCode.toUpperCase()) as { id: number; name: string } | undefined;
  if (!group) return res.status(404).json({ error: "Invite code not found" });
  const alreadyMember = membership.get(group.id, req.session.userId);
  if (!alreadyMember) {
    const count = (db.prepare("SELECT COUNT(*) AS count FROM memberships WHERE group_id=?").get(group.id) as { count: number }).count;
    if (count >= 16) return res.status(409).json({ error: "This group has reached the 16-member limit" });
    db.prepare("INSERT INTO memberships(group_id,user_id) VALUES(?,?)").run(group.id, req.session.userId);
  }
  res.json({ group: { ...group, inviteCode: parsed.data.inviteCode.toUpperCase() } });
});

app.get("/api/groups/:groupId", requireAuth, (req, res) => {
  const groupId = idSchema.safeParse(req.params.groupId);
  if (!groupId.success) return res.status(400).json({ error: "Invalid group ID" });
  if (!requireMembership(req, res, groupId.data)) return;
  const group = db.prepare("SELECT id,name,invite_code AS inviteCode FROM groups WHERE id=?").get(groupId.data);
  const members = db.prepare("SELECT u.id,u.name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.group_id=? ORDER BY u.name COLLATE NOCASE").all(groupId.data);
  const expenses = db.prepare(`SELECT e.id,e.description,e.amount_cents AS amountCents,e.created_at AS createdAt,
    e.payer_id AS payerId,u.name AS payerName FROM expenses e JOIN users u ON u.id=e.payer_id
    WHERE e.group_id=? ORDER BY e.id DESC LIMIT 100`).all(groupId.data);
  res.json({ group, members, expenses });
});

const amountSchema = z.string().regex(/^\d{1,7}(\.\d{1,2})?$/).refine(v => centsFromDecimal(v) > 0, "Amount must be greater than zero");
app.post("/api/groups/:groupId/expenses", requireAuth, (req, res) => {
  const groupId = idSchema.safeParse(req.params.groupId);
  if (!groupId.success) return res.status(400).json({ error: "Invalid group ID" });
  if (!requireMembership(req, res, groupId.data)) return;
  const parsed = z.object({
    description: z.string().trim().min(1).max(120), amount: amountSchema,
    splitType: z.enum(["equal", "custom"]), payerId: z.number().int().positive().optional(),
    splits: z.array(z.object({ userId: z.number().int().positive(), cents: z.number().int().nonnegative() })).optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid expense details", details: parsed.error.flatten() });
  const members = db.prepare("SELECT user_id AS userId FROM memberships WHERE group_id=? ORDER BY user_id").all(groupId.data) as { userId: number }[];
  const allowed = new Set(members.map(member => member.userId));
  const payerId = parsed.data.payerId ?? req.session.userId!;
  if (!allowed.has(payerId)) return res.status(400).json({ error: "Payer must be a group member" });
  if (members.length > 16) return res.status(409).json({ error: "Groups are limited to 16 members for exact minimum-payment settlement" });
  const totalCents = centsFromDecimal(parsed.data.amount);
  let splits: { userId: number; cents: number }[];
  if (parsed.data.splitType === "equal") {
    const base = Math.floor(totalCents / members.length), remainder = totalCents % members.length;
    splits = members.map((member, index) => ({ userId: member.userId, cents: base + (index < remainder ? 1 : 0) }));
  } else {
    splits = parsed.data.splits ?? [];
    if (splits.length !== members.length || new Set(splits.map(s => s.userId)).size !== members.length ||
        splits.some(s => !allowed.has(s.userId)) || splits.reduce((sum, s) => sum + s.cents, 0) !== totalCents)
      return res.status(400).json({ error: "Custom shares must include each member exactly once and add up to the expense total" });
  }
  const transaction = db.transaction(() => {
    const result = db.prepare("INSERT INTO expenses(group_id,payer_id,description,amount_cents) VALUES(?,?,?,?)")
      .run(groupId.data, payerId, parsed.data.description, totalCents);
    const insertSplit = db.prepare("INSERT INTO expense_splits(expense_id,user_id,amount_cents) VALUES(?,?,?)");
    for (const split of splits) insertSplit.run(result.lastInsertRowid, split.userId, split.cents);
    return Number(result.lastInsertRowid);
  });
  res.status(201).json({ expenseId: transaction(), amountCents: totalCents, splits });
});

app.get("/api/groups/:groupId/balances", requireAuth, (req, res) => {
  const groupId = idSchema.safeParse(req.params.groupId);
  if (!groupId.success) return res.status(400).json({ error: "Invalid group ID" });
  if (!requireMembership(req, res, groupId.data)) return;
  const members = db.prepare(`SELECT u.id AS userId,u.name,
    COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.group_id=? AND e.payer_id=u.id),0) -
    COALESCE((SELECT SUM(s.amount_cents) FROM expense_splits s JOIN expenses e ON e.id=s.expense_id WHERE e.group_id=? AND s.user_id=u.id),0) AS cents
    FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.group_id=? ORDER BY u.id`).all(groupId.data, groupId.data, groupId.data) as Balance[];
  const payments = settleUp(members);
  res.json({ balances: members, payments, totalPayments: payments.length });
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});
export { app };
if (require.main === module) app.listen(port, () => console.log(`API listening at http://localhost:${port}`));
