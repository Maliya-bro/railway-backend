// routes/settings-api.js
// Settings API routes for website integration
// Authentication: 6-digit code sent via WhatsApp (via Heroku bot)

import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import {
  getMongoUri,
  getMongoDb,
  getSessionCollection,
  getUnbanCode,
} from "../security.js";
import { MongoClient } from "mongodb";

const router = express.Router();

// ── MongoDB connection ──────────────────────────────────────
let _client = null;
let _db = null;

async function getDb() {
  if (_db) return _db;
  const uri = getMongoUri();
  if (!uri) throw new Error("MONGODB_URI missing");
  _client = new MongoClient(uri, { maxPoolSize: 5, family: 4 });
  await _client.connect();
  _db = _client.db(getMongoDb());
  return _db;
}

// ── Helper: Get session owner phone from MongoDB ────────────
async function getSessionOwnerPhone(sessionId) {
  if (!sessionId) return null;
  try {
    const db = await getDb();
    const col = db.collection(getSessionCollection());
    const doc = await col.findOne({ sessionId });
    return doc?.phone || null;
  } catch (e) {
    console.log(`⚠️ getSessionOwnerPhone error (${sessionId}):`, e?.message || e);
    return null;
  }
}

// ── Helper: Get session ID by phone ─────────────────────────
async function getSessionIdByPhone(phone) {
  if (!phone) return null;
  try {
    const db = await getDb();
    const col = db.collection(getSessionCollection());
    const doc = await col.findOne({ phone: String(phone).replace(/\D/g, "") });
    return doc?.sessionId || null;
  } catch (e) {
    console.log(`⚠️ getSessionIdByPhone error (${phone}):`, e?.message || e);
    return null;
  }
}

// ── Helper: Read settings from MongoDB ──────────────────────
async function readSettings(sessionId) {
  const id = String(sessionId || "default").trim() || "default";
  try {
    const db = await getDb();
    const col = db.collection("bot_settings");
    let doc = await col.findOne({ sessionId: id });
    if (!doc) {
      const defaults = {
        auto_status_seen: true,
        auto_status_react: true,
        auto_download_status: false,
        auto_msg: false,
        seen_all_msg: false,
        auto_react_msg: false,
        auto_react_mode: "all",
        mode: "public",
        work_scope: "private",
        anti_delete: true,
        auto_reject_calls: false,
        always_presence: "off",
        btns_enabled: false,
        anti_spam: false,
      };
      await col.updateOne(
        { sessionId: id },
        { $set: { ...defaults, updatedAt: new Date() } },
        { upsert: true }
      );
      doc = await col.findOne({ sessionId: id });
    }
    const settings = { ...doc };
    delete settings._id;
    delete settings.sessionId;
    return settings;
  } catch (e) {
    console.log(`⚠️ Settings read error (${id}):`, e?.message || e);
    return {};
  }
}

// ── Helper: Set setting ──────────────────────────────────────
async function setSetting(sessionId, key, value) {
  const id = String(sessionId || "default").trim() || "default";
  const db = await getDb();
  const col = db.collection("bot_settings");
  await col.updateOne(
    { sessionId: id },
    { $set: { [key]: value, updatedAt: new Date() } },
    { upsert: true }
  );
  return { [key]: value };
}

// ── Image management helpers ────────────────────────────────
async function getCustomImage(sessionId, key) {
  if (!sessionId || !key) return null;
  try {
    const db = await getDb();
    const col = db.collection("bot_images");
    const doc = await col.findOne({ sessionId, key });
    return doc || null;
  } catch { return null; }
}

async function setCustomImage(sessionId, key, dataUrl) {
  if (!sessionId || !key || !dataUrl) {
    throw new Error("sessionId, key, and dataUrl are required");
  }
  const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) {
    throw new Error("Invalid image data format. Must be a data URL.");
  }
  const mimeType = matches[1];
  const base64 = matches[2];
  const size = Buffer.byteLength(base64, "base64");
  const MAX_SIZE = 3 * 1024 * 1024;
  if (size > MAX_SIZE) {
    throw new Error(`Image size (${(size / 1024 / 1024).toFixed(2)}MB) exceeds 3MB limit.`);
  }
  const db = await getDb();
  const col = db.collection("bot_images");
  await col.updateOne(
    { sessionId, key },
    {
      $set: { data: dataUrl, mimeType, size, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  return { ok: true, size };
}

async function deleteCustomImage(sessionId, key) {
  if (!sessionId || !key) return false;
  const db = await getDb();
  const col = db.collection("bot_images");
  const result = await col.deleteOne({ sessionId, key });
  return result.deletedCount > 0;
}

async function listCustomImages(sessionId) {
  if (!sessionId) return [];
  const db = await getDb();
  const col = db.collection("bot_images");
  const docs = await col.find({ sessionId }).toArray();
  return docs.map((doc) => ({
    key: doc.key,
    mimeType: doc.mimeType,
    size: doc.size,
    updatedAt: doc.updatedAt,
  }));
}

// ── In-memory code store ─────────────────────────────────────
const codeStore = new Map();

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

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
  const secret = getUnbanCode() || "maliya-md-secret";
  try {
    const decoded = jwt.verify(token, secret);
    req.sessionId = decoded.sessionId;
    next();
  } catch (e) {
    return res.status(403).json({ ok: false, error: "Invalid or expired token." });
  }
}

// ── 🔥 SEND WHATSAPP MESSAGE VIA HEROKU BOT ──────────────────
// Heroku bot එකට HTTP request එකක් යවලා WhatsApp message send කරන්න
async function sendWhatsAppMessage(sessionId, phone, code) {
  // Heroku bot URL (settings API endpoint)
  const BOT_URL = process.env.BOT_URL || "https://your-heroku-bot.herokuapp.com";
  const BOT_API_KEY = process.env.BOT_API_KEY || "";

  try {
    const response = await axios.post(
      `${BOT_URL}/api/bot/send-message`,
      {
        sessionId,
        phone,
        message: `🔐 *MALIYA-MD Verification Code*\n\nYour verification code is:\n*${code}*\n\nThis code expires in 5 minutes.\n\nDo not share this code with anyone.`,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": BOT_API_KEY,
        },
        timeout: 10000,
      }
    );
    return response.data;
  } catch (error) {
    console.error("❌ Failed to send WhatsApp message via bot:", error.message);
    throw new Error("Failed to send verification code via WhatsApp.");
  }
}

// ── POST /api/settings/request-code ──────────────────────────
router.post("/request-code", async (req, res) => {
  try {
    const { sessionId, phone } = req.body;

    if (!sessionId && !phone) {
      return res.status(400).json({ ok: false, error: "sessionId or phone is required." });
    }

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

    const ownerPhone = await getSessionOwnerPhone(targetSessionId);
    if (!ownerPhone) {
      return res.status(404).json({ ok: false, error: "Session owner phone not found." });
    }

    const code = generateCode();
    codeStore.set(targetSessionId, {
      code,
      phone: ownerPhone,
      expires: Date.now() + 300000,
    });

    console.log(`📱 Verification code for ${targetSessionId}: ${code}`);

    // Send code via Heroku bot
    await sendWhatsAppMessage(targetSessionId, ownerPhone, code);

    res.json({
      ok: true,
      message: "Verification code sent to your WhatsApp.",
      sessionId: targetSessionId,
      phone: ownerPhone,
    });
  } catch (e) {
    console.error("❌ /request-code error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error. Please try again." });
  }
});

// ── POST /api/settings/verify-code ───────────────────────────
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

    const secret = getUnbanCode() || "maliya-md-secret";
    const token = jwt.sign({ sessionId }, secret, { expiresIn: "1h" });

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
router.get("/", verifyToken, async (req, res) => {
  try {
    const sessionId = req.sessionId;
    const settings = await readSettings(sessionId);
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
router.post("/", verifyToken, async (req, res) => {
  try {
    const sessionId = req.sessionId;
    const { settings = {}, images = {} } = req.body;

    for (const [key, value] of Object.entries(settings)) {
      await setSetting(sessionId, key, value);
    }

    for (const [key, dataUrl] of Object.entries(images)) {
      if (dataUrl === null || dataUrl === "") {
        await deleteCustomImage(sessionId, key);
      } else {
        await setCustomImage(sessionId, key, dataUrl);
      }
    }

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

export default router;
