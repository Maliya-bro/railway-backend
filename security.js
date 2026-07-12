// ═══════════════════════════════════════════════════════════════════
//  security-railway.js — Railway deployment සඳහා පමණි
//
//  - child_process blocking නෑ (Railway internal network needs it)
//  - env var deletion නෑ (Railway env vars Railway itself manage කරයි)
//  - Accessor functions පමණයි — same API as security.js
// ═══════════════════════════════════════════════════════════════════

// ─── Accessor functions — process.env කෙලින්ම කියවයි ───────────────
export function getMongoUri()          { return process.env.MONGODB_URI          || ""; }
export function getUnbanCode()         { return process.env.UNBAN_CODE           || ""; }
export function getAdminPw()           { return process.env.ADMIN_PW             || ""; }
export function getMongoDb()           { return process.env.MONGODB_DB           || "maliya_md"; }
export function getSessionCollection() { return process.env.SESSION_COLLECTION   || "wa_sessions"; }
export function getSessionSecret()     { return process.env.SESSION_SECRET       || ""; }
export function getGoogleClientId()    { return process.env.GOOGLE_CLIENT_ID     || ""; }
export function getGoogleClientSecret(){ return process.env.GOOGLE_CLIENT_SECRET || ""; }
export function getFrontendUrl()       { return process.env.FRONTEND_URL         || ""; }

// ─── Response redactor — sensitive values strings වලින් ඉවත් කරයි ──
export function redactSensitive(text) {
  if (!text || typeof text !== "string") return text;
  const patterns = [
    process.env.MONGODB_URI,
    process.env.UNBAN_CODE,
    process.env.ADMIN_PW,
    process.env.SESSION_SECRET,
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  ].filter(Boolean);

  let out = text;
  for (const val of patterns) {
    out = out.split(val).join("[REDACTED]");
  }
  return out;
}

// ─── console.error auto-redact ──────────────────────────────────────
const _origError = console.error.bind(console);
console.error = (...args) => {
  const sanitized = args.map(a =>
    typeof a === "string" ? redactSensitive(a) : a
  );
  _origError(...sanitized);
};

console.log("🔒 Railway security active: env vars protected (no deletion, no child_process block).");
