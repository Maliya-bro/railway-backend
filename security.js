// ═══════════════════════════════════════════════════════════════════
//  security.js — MUST be the FIRST import in index.js
//  Hardens the process before any other module loads.
//
//  1. Blocks all child_process execution methods (exec, spawn, fork…)
//  2. Prevents env var leaks via a redaction helper
//  3. Freezes the child_process module so it cannot be re-patched
// ═══════════════════════════════════════════════════════════════════

import cp from "child_process";

// ─── 1. Block all dangerous child_process methods ──────────────────
const BLOCKED_FN  = (..._args) => { throw new Error("⛔ child_process execution is disabled on this server."); };
const BLOCKED_OBJ = { stdout: null, stderr: null, stdin: null, pid: -1, killed: false, on: () => {}, kill: () => {} };

const DANGER_METHODS = [
  "exec", "execSync",
  "spawn", "spawnSync",
  "execFile", "execFileSync",
  "fork",
];

for (const method of DANGER_METHODS) {
  if (typeof cp[method] === "function") {
    Object.defineProperty(cp, method, {
      value: BLOCKED_FN,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }
}

// Freeze the module to prevent re-assignment of blocked functions
try { Object.freeze(cp); } catch (_) {}

// ─── 2. Snapshot + redact sensitive env vars ───────────────────────
//  Store values in closed-scope constants; delete from process.env
//  so they cannot be read by later code or leaked via error dumps.
//  mongodb.js and jwt helpers read these before this module deletes them
//  ONLY if they were imported before security.js. Because security.js
//  is the FIRST import, callers must use the exported accessors below.
const _MONGODB_URI          = process.env.MONGODB_URI          || "";
const _UNBAN_CODE           = process.env.UNBAN_CODE           || "";
const _ADMIN_PW             = process.env.ADMIN_PW             || "";
const _MONGODB_DB           = process.env.MONGODB_DB           || "maliya_md";
const _SESSION_COLLECTION   = process.env.SESSION_COLLECTION   || "wa_sessions";
const _SESSION_SECRET       = process.env.SESSION_SECRET       || "";
const _GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const _GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

// Delete from process.env so nothing can accidentally log/expose them
delete process.env.MONGODB_URI;
delete process.env.UNBAN_CODE;
delete process.env.ADMIN_PW;
delete process.env.SESSION_SECRET;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

// Re-expose ONLY through frozen accessor functions — never raw strings
export function getMongoUri()          { return _MONGODB_URI; }
export function getUnbanCode()         { return _UNBAN_CODE; }
export function getAdminPw()           { return _ADMIN_PW; }
export function getMongoDb()           { return _MONGODB_DB; }
export function getSessionCollection() { return _SESSION_COLLECTION; }
export function getSessionSecret()     { return _SESSION_SECRET; }
export function getGoogleClientId()    { return _GOOGLE_CLIENT_ID; }
export function getGoogleClientSecret(){ return _GOOGLE_CLIENT_SECRET; }

// ─── 3. Response redactor — strips env var values from any string ──
const SENSITIVE_PATTERNS = [
  _MONGODB_URI, _UNBAN_CODE, _ADMIN_PW,
  _SESSION_SECRET, _GOOGLE_CLIENT_ID, _GOOGLE_CLIENT_SECRET,
].filter(Boolean);

export function redactSensitive(text) {
  if (!text || typeof text !== "string") return text;
  let out = text;
  for (const val of SENSITIVE_PATTERNS) {
    out = out.split(val).join("[REDACTED]");
  }
  return out;
}

// ─── 4. Patch console.error to auto-redact sensitive output ────────
const _origError = console.error.bind(console);
console.error = (...args) => {
  const sanitized = args.map(a =>
    typeof a === "string" ? redactSensitive(a) : a
  );
  _origError(...sanitized);
};

console.log("🔒 Security hardening active: child_process blocked, env vars redacted.");
