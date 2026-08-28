// ⚠️  security.js MUST be the first import — it blocks child_process
//     and deletes sensitive env vars before any other module can read them.
import { getUnbanCode, redactSensitive, getSessionSecret, getFrontendUrl } from "./security.js";

import express    from "express";
import helmet     from "helmet";
import cors       from "cors";
import jwt        from "jsonwebtoken";
import { fileURLToPath } from "url";
import path       from "path";
import http       from "http";
import rateLimit  from "express-rate-limit";
import { createRequire } from "module";

// ── CJS packages (hpp, cookie-parser, express-session) via createRequire ──
const require        = createRequire(import.meta.url);
const hpp            = require("hpp");
const cookieParser   = require("cookie-parser");
const session        = require("express-session");

import "./logger.js";
import { addLogClient }         from "./logger.js";
import { warmupDb, keepAlivePing } from "./mongodb.js";
import securityLogger           from "./lib/securityLogger.js";

process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled rejection (non-fatal):", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught exception (non-fatal):", err?.message || err);
});

import pairRouter      from "./pair.js";
import qrRouter        from "./qr.js";
import adminPanelRouter from "./admin-panel.js";
import chatRouter       from "./chat.js";
import ytRouter         from "./yt.js";
import authRouter, { passport } from "./auth.js";
import apiKeysRouter    from "./api-keys.js";
import { getSessionId, setSessionId } from "./session-store.js";

// 🔥 NEW: Settings API routes (for website settings panel)
import settingsApiRouter from "./routes/settings-api.js";

const app        = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PORT       = process.env.PORT || 3000;

import("events").then((m) => { m.EventEmitter.defaultMaxListeners = 500; });

// ─────────────────────────────────────────────────────────────────
//  Trust Replit's reverse proxy — real client IP from X-Forwarded-For
// ─────────────────────────────────────────────────────────────────
app.set("trust proxy", 1);

// ─────────────────────────────────────────────────────────────────
//  LAYER 01 — HELMET: HTTP security headers
//  (XSS, clickjacking, MIME sniffing protection)
// ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy:    false, // pair.html uses inline scripts
  crossOriginEmbedderPolicy: false,
}));

// ─────────────────────────────────────────────────────────────────
//  LAYER 02 — CORS: allow Replit + Vercel + custom FRONTEND_URL
//  Set FRONTEND_URL env var on Railway for a custom domain, e.g.
//  "https://maliya-md.vercel.app"
// ─────────────────────────────────────────────────────────────────
const _FRONTEND_URL = process.env.FRONTEND_URL || "";
delete process.env.FRONTEND_URL; // keep env clean

app.use(cors({
  origin: (origin, cb) => {
    if (
      !origin ||
      /\.replit\.app$/.test(origin) ||
      /\.repl\.co$/.test(origin)   ||
      /\.replit\.dev$/.test(origin) ||
      /\.repl\.run$/.test(origin)  ||
      /\.vercel\.app$/.test(origin) ||
      /\.vercel\.dev$/.test(origin) ||
      /^http:\/\/localhost(:\d+)?$/.test(origin) || // ✅ localhost testing
      (_FRONTEND_URL && origin === _FRONTEND_URL)
    ) {
      cb(null, true);
    } else {
      securityLogger.warn(`CORS_BLOCKED origin="${origin}"`);
      cb(new Error("CORS: origin not allowed"));
    }
  },
  methods:        ["GET", "POST", "DELETE", "OPTIONS"], // ✅ OPTIONS added
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-settings-token"], // ✅ x-settings-token added
  credentials:    true,   // required for cross-origin HttpOnly cookies
}));

// ─────────────────────────────────────────────────────────────────
//  LAYER 03 — PAYLOAD SIZE LIMIT: block oversized JSON bodies
//  Prevents DoS via huge POST payloads (max 10 kb)
// ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// ─────────────────────────────────────────────────────────────────
//  LAYER 04 — HPP: HTTP Parameter Pollution protection
//  Blocks ?sort=asc&sort=desc array injection attacks
//  Must come AFTER body parsers
// ─────────────────────────────────────────────────────────────────
app.use(hpp());

// ─────────────────────────────────────────────────────────────────
//  LAYER 05 — COOKIE PARSER: read HttpOnly JWT cookies
// ─────────────────────────────────────────────────────────────────
app.use(cookieParser());

// ─────────────────────────────────────────────────────────────────
//  LAYER 05b — SESSION + PASSPORT (Google OAuth)
// ─────────────────────────────────────────────────────────────────
app.use(session({
  secret:            getSessionSecret() || "maliya-md-fallback-secret",
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // On Railway (production) cookies cross Vercel→Railway over HTTPS,
    // so sameSite must be "none" + secure:true.
    // On Replit (dev) keep "lax" + secure:false.
    secure:   process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge:   7 * 24 * 60 * 60 * 1000,  // 7 days
  },
}));
app.use(passport.initialize());
app.use(passport.session());

// ─────────────────────────────────────────────────────────────────
//  Unban list — IPs that passed the unban code check
// ─────────────────────────────────────────────────────────────────
const unbanList = new Map();

function getClientIP(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return forwarded ? forwarded.split(",")[0].trim() : req.socket.remoteAddress;
}

// ─────────────────────────────────────────────────────────────────
//  LAYER 06 — RATE LIMITER: 10 requests / 24 h per IP
//  Applied to /pair and /qr. Logs hits to security.log
// ─────────────────────────────────────────────────────────────────
const generateLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => {
    const ip = getClientIP(req);
    const unbanExpiry = unbanList.get(ip);
    if (unbanExpiry && unbanExpiry > Date.now()) return `unbanned_${ip}_${unbanExpiry}`;
    return ip;
  },
  handler: (req, res) => {
    const ip         = getClientIP(req);
    const retryAfter = res.getHeader("Retry-After") || 86400;
    const banExpiry  = Date.now() + Number(retryAfter) * 1000;
    securityLogger.warn(
      `RATE_LIMIT_HIT ip=${ip} path=${req.path} ua="${(req.headers["user-agent"] || "").slice(0, 80)}"`
    );
    res.status(429).json({
      banned: true,
      banExpiry,
      message: "There are abnormal activities with your IP — it has been suspended.",
    });
  },
  skip: (req) =>
    req.path === "/health" || req.path === "/_health" || req.path === "/ping",
});

// ─────────────────────────────────────────────────────────────────
//  Health / ping
// ─────────────────────────────────────────────────────────────────
app.get(["/health", "/_health", "/ping"], (_req, res) => res.status(200).send("OK"));

// ─────────────────────────────────────────────────────────────────
//  SSE log stream — open to same-origin clients (pair/QR console)
//  Sensitive values are already deleted from process.env by security.js
//  and console.error auto-redacts via its patched wrapper there.
// ─────────────────────────────────────────────────────────────────
app.get("/events", (req, res) => {
  res.set({
    "Content-Type":    "text/event-stream",
    "Cache-Control":   "no-cache",
    Connection:        "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const remove = addLogClient(res);
  const hb     = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 25000);
  req.on("close", () => { clearInterval(hb); remove(); });
});

// ─────────────────────────────────────────────────────────────────
//  LAYER 07 — NoSQL INJECTION PROTECTION (Express 5 compatible)
//  Blocks keys starting with '$' or containing '.'
//  Also logs each blocked attempt to security.log
// ─────────────────────────────────────────────────────────────────
function sanitizeMongo(obj, ip = "") {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith("$") || key.includes(".")) {
      const safeKey = key.replace(/\$/g, "_").replace(/\./g, "_");
      obj[safeKey]  = obj[key];
      delete obj[key];
      console.warn(`⚠️ NoSQL injection key blocked: "${key}" → "${safeKey}"`);
      securityLogger.warn(`NOSQL_INJECTION_BLOCKED ip=${ip} key="${key}"`);
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      sanitizeMongo(obj[key], ip);
    }
  }
}

app.use((req, _res, next) => {
  const ip = getClientIP(req);
  sanitizeMongo(req.body,   ip);
  sanitizeMongo(req.params, ip);
  next();
});

// ─────────────────────────────────────────────────────────────────
//  Static files + home page
// ─────────────────────────────────────────────────────────────────
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  try {
    res.set({ "Cache-Control": "no-store, no-cache, must-revalidate", Pragma: "no-cache" });
    res.sendFile(path.join(__dirname, "pair.html"));
  } catch (err) {
    console.error("UI load error:", err);
    res.status(500).send("Error loading UI");
  }
});

// ─────────────────────────────────────────────────────────────────
//  Unban verification endpoint  POST /unban-verify { code }
// ─────────────────────────────────────────────────────────────────
app.post("/unban-verify", (req, res) => {
  const { code }       = req.body || {};
  const correctCode    = getUnbanCode();
  const ip             = getClientIP(req);

  if (!correctCode) {
    return res.status(503).json({ ok: false, error: "Unban service not configured." });
  }
  if (!code || String(code).trim() !== String(correctCode).trim()) {
    securityLogger.warn(`UNBAN_WRONG_CODE ip=${ip}`);
    return res.status(403).json({ ok: false, error: "Invalid code. Try again." });
  }

  unbanList.set(ip, Date.now() + 24 * 60 * 60 * 1000);
  for (const [key, expiry] of unbanList.entries()) {
    if (expiry < Date.now()) unbanList.delete(key);
  }

  console.log(`✅ Unban granted for IP: ${ip}`);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────
//  LAYER 08 — JWT AUTH (Bearer header + HttpOnly Cookie)
//  /admin/token  → issues token as HttpOnly Secure cookie AND JSON
//  requireJWT    → accepts either Bearer header or cookie
// ─────────────────────────────────────────────────────────────────
function requireJWT(req, res, next) {
  const secret = getUnbanCode();
  if (!secret) return res.status(503).json({ ok: false, error: "Auth not configured." });

  // Accept from cookie (preferred) or Authorization: Bearer header
  const fromCookie = req.cookies?.adminToken;
  const authHeader  = req.headers["authorization"] || "";
  const fromHeader  = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const token       = fromCookie || fromHeader;

  if (!token) {
    securityLogger.warn(`AUTH_MISSING ip=${getClientIP(req)} path=${req.path}`);
    return res.status(401).json({ ok: false, error: "Missing token." });
  }
  try {
    req.jwtPayload = jwt.verify(token, secret);
    next();
  } catch {
    securityLogger.warn(`AUTH_INVALID ip=${getClientIP(req)} path=${req.path}`);
    return res.status(403).json({ ok: false, error: "Invalid or expired token." });
  }
}

// POST /admin/token — issue 1-hour JWT; set as HttpOnly cookie + JSON
app.post("/admin/token", (req, res) => {
  const secret = getUnbanCode();
  if (!secret) return res.status(503).json({ ok: false, error: "Auth not configured." });

  const { code } = req.body || {};
  const ip       = getClientIP(req);

  if (!code || String(code).trim() !== String(secret).trim()) {
    securityLogger.warn(`ADMIN_TOKEN_WRONG_CODE ip=${ip}`);
    return res.status(403).json({ ok: false, error: "Invalid code." });
  }

  const token = jwt.sign({ role: "admin" }, secret, { expiresIn: "1h" });

  // ── LAYER 09 — HttpOnly Secure Cookie ───────────────────────
  //  JS ගෙන් read කරන්නේ බෑ → XSS attacks ට token leak නොවෙ
  res.cookie("adminToken", token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge:   60 * 60 * 1000, // 1 hour
  });

  console.log(`🔑 Admin JWT issued for IP: ${ip}`);
  res.json({ ok: true, token }); // token ත් return (backward compat)
});

// POST /admin/logout — clear the HttpOnly cookie
app.post("/admin/logout", (_req, res) => {
  res.clearCookie("adminToken");
  res.json({ ok: true });
});

app.get("/session-id", (_req, res) => res.json({ sessionId: getSessionId() }));

app.post("/session-id/clear", requireJWT, (_req, res) => {
  setSessionId("");
  console.log(`🗑️ Session cleared by admin (IP: ${getClientIP(_req)})`);
  res.json({ ok: true });
});

// Health check — Railway / uptime monitors
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "OK", message: "Server is healthy" });
});

// Google OAuth
app.use("/auth",     authRouter);
app.use("/api-keys", apiKeysRouter);

// Apply rate limiter to pair and qr routes
app.use("/pair",     generateLimiter, pairRouter);
app.use("/qr",       generateLimiter, qrRouter);
app.use("/api/chat", chatRouter);
app.use("/yt",       ytRouter);

// Secret admin panel — no link from main site, pw-protected
app.use("/x-admin", adminPanelRouter);

// 🔥 NEW: Settings API Routes (for website settings panel)
app.use("/api/settings", settingsApiRouter);

// ─────────────────────────────────────────────────────────────────
//  LAYER 10 — SECURE GLOBAL ERROR HANDLER
//  Redacts sensitive values, never leaks stack traces
// ─────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const safeMsg = redactSensitive(err?.message || "An unexpected error occurred.");
  console.error(`❌ [${req.method} ${req.path}] ${safeMsg}`);
  securityLogger.warn(`SERVER_ERROR method=${req.method} path=${req.path} msg="${safeMsg.slice(0, 120)}"`);
  const status = typeof err?.status === "number" ? err.status : 500;
  res.status(status).json({ error: safeMsg });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  warmupDb().then(() => { setInterval(keepAlivePing, 30 * 1000); });
  setInterval(() => {
    http.get(`http://localhost:${PORT}/health`, (r) => r.resume()).on("error", () => {});
  }, 4 * 60 * 1000);
});
