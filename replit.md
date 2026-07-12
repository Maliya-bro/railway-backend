# MALIYA-MD — WhatsApp Pair Code Generator

A secure WhatsApp session pair-code/QR-code generator web app built with Node.js + Express.

## How to run

```
npm start
```

The app starts on port 5000 (`node index.js`).

## Stack

- **Runtime**: Node.js ≥ 20 (ES Modules)
- **Web framework**: Express 5
- **WhatsApp library**: @whiskeysockets/baileys (7.x — 6.x blocked on Replit due to git sub-dependency)
- **Database**: MongoDB (connection managed in `mongodb.js`)
- **Auth**: JWT (HttpOnly cookie + Bearer header) via `jsonwebtoken`
- **Security**: helmet, cors, hpp, express-rate-limit, custom NoSQL sanitiser, child_process blocked

## Required secrets (set in Replit Secrets)

| Secret | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string |
| `UNBAN_CODE` | Admin JWT secret + IP unban code |
| `ADMIN_PW` | Password for the `/x-admin` panel |
| `SESSION_SECRET` | Session signing secret |

## Optional env vars

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_DB` | `maliya_md` | Database name |
| `SESSION_COLLECTION` | `wa_sessions` | Collection for WA sessions |
| `MAX_ACTIVE_SESSIONS` | `50` | Max concurrent sessions |
| `PORT` | `5000` | HTTP port |

## Key routes

- `/` — Main pair-code UI (`pair.html`)
- `/pair` — Pair-code generation endpoint (rate-limited)
- `/qr` — QR-code endpoint (rate-limited)
- `/x-admin` — Admin panel (JWT-protected)
- `/admin/token` — Issue admin JWT (POST `{ code }`)
- `/unban-verify` — Unban an IP (POST `{ code }`)
- `/health` — Health check

## File layout

| File | Purpose |
|---|---|
| `index.js` | Main server — security middleware stack, routing |
| `security.js` | MUST be first import; blocks child_process, redacts env vars |
| `pair.js` | `/pair` route — WhatsApp pair-code logic |
| `qr.js` | `/qr` route — QR code logic |
| `admin-panel.js` | `/x-admin` admin panel |
| `mongodb.js` | MongoDB connection + keep-alive |
| `logger.js` | SSE log streaming |
| `session-store.js` | In-memory session ID store |
| `lib/securityLogger.js` | Security event logger |

## User preferences

- Keep the existing project structure and security model intact.
- Use baileys `7.x` on Replit (6.x has a git sub-dependency blocked by Replit's security policy).
