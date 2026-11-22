# Roomie — shared-expense splitter

A runnable TypeScript full-stack starter for roommates: React + Vite, Express, SQLite (`better-sqlite3`), Zod validation, bcrypt password hashes, and server-side SQLite sessions in an httpOnly cookie.

## Requirements

- Node.js 22+ and npm (required by the current `better-sqlite3` release)
- SQLite is embedded through `better-sqlite3`; no separate database server

## Run locally

```sh
cp server/.env.example server/.env
# Replace SESSION_SECRET in server/.env with a unique random value (for example: openssl rand -base64 32)
npm install
npm --prefix server install
npm --prefix client install
npm run dev
```

Open <http://localhost:5173>. Vite forwards `/api` to Express on port 3000. The API creates `server/data/roommates.sqlite` on first run. To run the checks and production builds:

```sh
npm test
npm run build
```

`npm start` runs the built API only. The development command is the complete local app. For production, serve the built client from a same-origin web server/reverse proxy to the API over HTTPS; set `NODE_ENV=production`, a strong `SESSION_SECRET`, and a persistent `DATABASE_PATH`. If TLS terminates at a trusted reverse proxy, set `TRUST_PROXY=1` only when exactly one trusted TLS-terminating reverse proxy is in front of Express. No deployment configuration is included.

## API

- `POST /api/auth/signup` `{ name, email, password }` (password 10–72 characters)
- `POST /api/auth/login` `{ email, password }`
- `POST /api/auth/logout`; `GET /api/auth/me`
- `GET /api/groups`; `POST /api/groups` `{ name }`; `POST /api/groups/join` `{ inviteCode }`
- `GET /api/groups/:groupId` — household, members, last 100 expenses
- `POST /api/groups/:groupId/expenses` `{ description, amount: "12.34", splitType: "equal"|"custom", payerId?, splits?: [{userId,cents}] }`
- `GET /api/groups/:groupId/balances` — net balances in cents and minimum-payment plan

Money uses integer cents in storage/API results. Equal splitting assigns leftover cents in stable user-ID order. Custom shares must list each member exactly once and sum to the expense amount. Exact minimum-payment settlement is NP-hard; groups are capped at 16 members to bound the search. Invite codes grant membership, so share them privately.

## Security / operational notes

- Passwords are bcrypt-hashed (cost 12); session IDs are regenerated on signup/login, persisted in SQLite, and never exposed to the browser.
- Cookie flags: `httpOnly`, `SameSite=Strict`, and `Secure` in production. Mutating requests with an `Origin` header are restricted to the request host.
- No rate limiting, email verification, password reset, or audit log yet. Regression tests cover authentication, membership, expense validation, payer selection in the API, and production session-secret requirements. Add rate limits and account recovery before public launch; enforce HTTPS at the edge and back up the SQLite file. `better-sqlite3` is synchronous and is suitable for a small single-node household app, not a high-write multi-node deployment.
