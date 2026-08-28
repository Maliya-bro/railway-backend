// routes/settings-api.js
// Settings API routes for website integration
// Authentication: 6-digit code sent via WhatsApp

const express = require("express");
const jwt = require("jsonwebtoken");
const {
  readSettings,
  setSetting,
  toggleSetting,
  getSessionOwnerPhone,
  getSessionIdByPhone,
  getCustomImage,
  setCustomImage,
  deleteCustomImage,
  listCustomImages,
} = require("../lib/botSettings");

const router = express.Router();

// ── In-memory code store (use Redis in production) ──────────
const codeStore = new Map(); // key: sessionId, value: { code, phone, expires }

// ── Generate 6-digit code ────────────────────────────────────
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Clean expired codes every 5 minutes ─────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of codeStore) {
    if (value.expires < now) {
      codeStore.delete(key);
    }
  }
}, 300000);

// ── Middleware: Verify JWT token ─────────────────────────────
function verifyToken(req, res, next) {
  const token = req.headers["x-settings-token"] || req.query.token;
  if (!token) {
    return res.status(401).json({ ok: false, error: "Missing authentication token." });
  }

  const secret = process.env.UNBAN_CODE || process.env.SESSION_SECRET || "maliya-md-secret";
  try {
    const decoded = jwt.verify(token, secret);
    req.sessionId = decoded.sessionId;
    next();
  } catch (e) {
    return res.status(403).json({ ok: false, error: "Invalid or expired token." });
  }
}

// ── POST /api/settings/request-code ──────────────────────────
// Body: { sessionId, phone }
// Sends 6-digit code to the owner's WhatsApp number
router.post("/request-code", async (req, res) => {
  try {
    const { sessionId, phone } = req.body;

    if (!sessionId && !phone) {
      return res.status(400).json({ ok: false, error: "sessionId or phone is required." });
    }

    // If phone provided, find sessionId
    let targetSessionId = sessionId;
    if (phone && !sessionId) {
      targetSessionId = await getSessionIdByPhone(phone);
      if (!targetSessionId) {
        return res.status(404).json({ ok: false, error: "No session found for this phone number." });
      }
    }

    if (!targetSessionId) {
      return res.status(400).json({ ok: false, error: "sessionId is required." });
    }

    // Get owner phone
    const ownerPhone = await getSessionOwnerPhone(targetSessionId);
    if (!ownerPhone) {
      return res.status(404).json({ ok: false, error: "Session owner phone not found." });
    }

    // Generate and store code
    const code = generateCode();
    codeStore.set(targetSessionId, {
      code,
      phone: ownerPhone,
      expires: Date.now() + 300000, // 5 minutes
    });

    console.log(`📱 Verification code for ${targetSessionId}: ${code}`);

    // Send code via WhatsApp (requires bot instance)
    // We'll use the global activeSessions from index.js
    const activeSessions = global.__maliya_active_sessions || new Map();
    const sessionCtx = activeSessions.get(targetSessionId);
    if (!sessionCtx || !sessionCtx.sock) {
      return res.status(503).json({ ok: false, error: "Bot is not connected for this session." });
    }

    try {
      await sessionCtx.sock.sendMessage(ownerPhone + "@s.whatsapp.net", {
        text: `🔐 *MALIYA-MD Verification Code*\n\nYour verification code is:\n*${code}*\n\nThis code expires in 5 minutes.\n\nDo not share this code with anyone.`,
      });
      console.log(`✅ Verification code sent to ${ownerPhone}`);
    } catch (sendErr) {
      console.log("⚠️ Failed to send WhatsApp message:", sendErr.message);
      return res.status(503).json({ ok: false, error: "Failed to send verification code via WhatsApp." });
    }

    // Store sessionId for later use (verify endpoint will use it)
    res.json({
      ok: true,
      message: "Verification code sent to your WhatsApp.",
      sessionId: targetSessionId,
      phone: ownerPhone,
    });
  } catch (e) {
    console.error("❌ /request-code error:", e);
    res.status(500).json({ ok: false, error: "Server error. Please try again." });
  }
});

// ── POST /api/settings/verify-code ───────────────────────────
// Body: { sessionId, code }
// Returns JWT token on success
router.post("/verify-code", async (req, res) => {
  try {
    const { sessionId, code } = req.body;

    if (!sessionId || !code) {
      return res.status(400).json({ ok: false, error: "sessionId and code are required." });
    }

    const stored = codeStore.get(sessionId);
    if (!stored) {
      return res.status(403).json({ ok: false, error: "No verification request found. Please request a new code." });
    }

    if (stored.expires < Date.now()) {
      codeStore.delete(sessionId);
      return res.status(403).json({ ok: false, error: "Code has expired. Please request a new one." });
    }

    if (stored.code !== code) {
      return res.status(403).json({ ok: false, error: "Invalid code. Please try again." });
    }

    // Success - generate JWT token
    const secret = process.env.UNBAN_CODE || process.env.SESSION_SECRET || "maliya-md-secret";
    const token = jwt.sign({ sessionId }, secret, { expiresIn: "1h" });

    // Delete used code
    codeStore.delete(sessionId);

    res.json({
      ok: true,
      token,
      sessionId,
      expiresIn: 3600,
    });
  } catch (e) {
    console.error("❌ /verify-code error:", e);
    res.status(500).json({ ok: false, error: "Server error. Please try again." });
  }
});

// ── GET /api/settings ────────────────────────────────────────
// Headers: { x-settings-token: <jwt> }
// Returns all settings + images for the session
router.get("/", verifyToken, async (req, res) => {
  try {
    const sessionId = req.sessionId;

    // Get settings
    const settings = await readSettings(sessionId);

    // Get custom images list
    const images = await listCustomImages(sessionId);

    res.json({
      ok: true,
      settings,
      images,
    });
  } catch (e) {
    console.error("❌ GET /settings error:", e);
    res.status(500).json({ ok: false, error: "Failed to load settings." });
  }
});

// ── POST /api/settings ───────────────────────────────────────
// Headers: { x-settings-token: <jwt> }
// Body: { settings: { key: value }, images: { key: "data:image/..." } }
router.post("/", verifyToken, async (req, res) => {
  try {
    const sessionId = req.sessionId;
    const { settings = {}, images = {} } = req.body;

    // ── Update settings ──────────────────────────────────────
    for (const [key, value] of Object.entries(settings)) {
      if (key === "mode" || key === "work_scope" || key === "always_presence" || key === "auto_react_mode") {
        // These need validation (handled by setSetting)
        await setSetting(sessionId, key, value);
      } else if (typeof value === "boolean") {
        // Boolean settings: use setSetting
        await setSetting(sessionId, key, value);
      } else {
        // Unknown setting - skip
        console.log(`⚠️ Unknown setting: ${key}=${value}`);
      }
    }

    // ── Update images ────────────────────────────────────────
    for (const [key, dataUrl] of Object.entries(images)) {
      if (dataUrl === null || dataUrl === "") {
        // Delete image
        await deleteCustomImage(sessionId, key);
      } else {
        // Upload/update image
        await setCustomImage(sessionId, key, dataUrl);
      }
    }

    // Get updated settings and images
    const updatedSettings = await readSettings(sessionId);
    const updatedImages = await listCustomImages(sessionId);

    res.json({
      ok: true,
      settings: updatedSettings,
      images: updatedImages,
    });
  } catch (e) {
    console.error("❌ POST /settings error:", e);
    const status = e.message.includes("exceeds 3MB") ? 400 : 500;
    res.status(status).json({ ok: false, error: e.message || "Failed to update settings." });
  }
});

// ── DELETE /api/settings/image/:key ──────────────────────────
// Headers: { x-settings-token: <jwt> }
router.delete("/image/:key", verifyToken, async (req, res) => {
  try {
    const sessionId = req.sessionId;
    const key = req.params.key;

    if (!key) {
      return res.status(400).json({ ok: false, error: "Image key is required." });
    }

    const deleted = await deleteCustomImage(sessionId, key);
    res.json({ ok: deleted, key });
  } catch (e) {
    console.error("❌ DELETE /image error:", e);
    res.status(500).json({ ok: false, error: "Failed to delete image." });
  }
});

module.exports = router;
