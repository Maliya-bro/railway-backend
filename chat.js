// ═══════════════════════════════════════════════════════════════
//  chat.js — MALIYA-MD AI Chat API
//  Adapted from auto_msg.js for web use (ESM, no WhatsApp deps)
//  Providers: Gemini (optional user key) → ch.at → pollinations.ai
// ═══════════════════════════════════════════════════════════════

import express      from "express";
import axios        from "axios";
import { MongoClient } from "mongodb";
import { getMongoUri, getMongoDb } from "./security.js";

const router = express.Router();

// ─── MongoDB (lightweight own connection) ────────────────────
let _client = null;
let _db     = null;
async function getDb() {
  if (_db) return _db;
  const uri = getMongoUri();
  if (!uri) throw new Error("MONGODB_URI missing");
  _client = new MongoClient(uri, { maxPoolSize: 5, family: 4 });
  await _client.connect();
  _db = _client.db(getMongoDb());
  return _db;
}

// ─── Language Detection ──────────────────────────────────────
const SI_UNICODE  = /[\u0D80-\u0DFF]/;
const TA_UNICODE  = /[\u0B80-\u0BFF]/;
const SINGLISH_KW = [
  "mata","oya","mage","mokak","mokada","kohomada","karanna","puluwan",
  "thiyenawa","wenawa","kiyanne","kiyala","ane","machan","bro","ganna",
  "danna","hadanne","thiyanawa","wela","neda","api","eka","epa","wenna",
  "balanna","thawa","honda","tikak","godak","oyata","meka","oyage",
  "kawda","kawruwat","mona","hari","naha","inne","hitiye","giye","aawa",
  "gawa","danne","thene","wenne","denne","lassana","nangi","aiya",
  "akka","ayye","malli","duwa","putha","ammae","thaathae","apita","apige",
];
function detectLang(text) {
  if (SI_UNICODE.test(text))  return "si";
  if (TA_UNICODE.test(text))  return "ta";
  const lower = text.toLowerCase();
  if (SINGLISH_KW.some(w => lower.includes(w))) return "singlish";
  return "en";
}

// ─── System Prompt ───────────────────────────────────────────
function buildSystemPrompt(lang) {
  if (lang === "singlish") {
    return (
      "Oya MALIYA-MD AI Assistant. Oya friendly, helpful AI chatbot ekak. " +
      "Obage replies Sinhala Unicode walin liyanna (Sinhala Unicode script use karaganna). " +
      "Short, friendly, natural chat style. Emojis use karanna. " +
      "Previous conversation context use karala relevant replies denna."
    );
  }
  if (lang === "si") {
    return (
      "ඔයා MALIYA-MD AI Assistant. ඔයා friendly, helpful AI chatbot කෙනෙක්. " +
      "සෑම reply එකක්ම සම්පූර්ණ සිංහල Unicode ගෙන් ලියන්න — Singlish use කරන්නෙ නෑ. " +
      "Short, friendly, natural chat style. Emojis use කරන්න. " +
      "කලින් conversation context use කරලා relevant replies දෙන්න."
    );
  }
  if (lang === "ta") {
    return (
      "நீங்கள் MALIYA-MD AI Assistant — நட்பான, உதவியான AI chatbot. " +
      "தமிழில் மட்டும் பதில் சொல்லுங்கள். Emojis பயன்படுத்துங்கள். " +
      "குறுகியதாக, நட்பாக பேசுங்கள். முந்தைய உரையாடல் context பயன்படுத்தி பதில் சொல்லுங்கள்."
    );
  }
  return (
    "You are MALIYA-MD AI Assistant — a friendly, helpful AI chatbot. " +
    "Reply ONLY in English. Use emojis to feel warm and expressive. " +
    "Be short, friendly, and conversational. " +
    "Use previous conversation history for context when replying."
  );
}

// ─── Chat History (MongoDB, per browser session) ─────────────
const HISTORY_MAX = 20;

async function getHistory(sessionId) {
  try {
    const db  = await getDb();
    const doc = await db.collection("web_chat_history").findOne({ sessionId });
    return doc ? (doc.messages || []) : [];
  } catch { return []; }
}

async function appendHistory(sessionId, role, text) {
  const db = await getDb();
  await db.collection("web_chat_history").updateOne(
    { sessionId },
    {
      $push: {
        messages: {
          $each:  [{ role, text: String(text).slice(0, 2000), ts: Date.now() }],
          $slice: -HISTORY_MAX,
        },
      },
      $set:        { updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

async function clearHistory(sessionId) {
  try {
    const db = await getDb();
    await db.collection("web_chat_history").updateOne(
      { sessionId },
      { $set: { messages: [], updatedAt: new Date() } },
      { upsert: true }
    );
  } catch {}
}

// ─── Gemini ──────────────────────────────────────────────────
const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"];

async function callGemini(apiKey, systemPrompt, history, userText) {
  const contents = [];
  contents.push({ role: "user",  parts: [{ text: systemPrompt }] });
  contents.push({ role: "model", parts: [{ text: "Understood." }] });
  for (const turn of history) {
    contents.push({
      role:  turn.role === "user" ? "user" : "model",
      parts: [{ text: turn.text }],
    });
  }
  contents.push({ role: "user", parts: [{ text: userText }] });

  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await axios.post(url, { contents }, {
        headers: { "Content-Type": "application/json" },
        timeout: 28000,
      });
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
      if (text) return { text: text.trim(), source: `gemini/${model}` };
    } catch (e) {
      const status = e?.response?.status;
      if (status === 400) break;
      if (status === 429) continue;
    }
  }
  return null;
}

// ─── ch.at (free) ────────────────────────────────────────────
async function callChAt(prompt, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.post(
        "https://ch.at/api/chat",
        { message: prompt },
        {
          headers: { "Content-Type": "application/json", "User-Agent": "MALIYA-MD-Bot/2.0" },
          timeout: 12000,
        }
      );
      const t = res.data?.answer || res.data?.reply || res.data?.message ||
                res.data?.response || res.data?.result;
      if (t && String(t).trim().length > 2) return { text: String(t).trim(), source: "ch.at" };
    } catch {}
    if (i < retries) await new Promise(r => setTimeout(r, 500 * i));
  }
  return null;
}

// ─── pollinations.ai — OpenAI-compatible POST (no char limit) ─
async function callPollinations(systemPrompt, history, userText) {
  try {
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    for (const turn of history.slice(-8)) {
      messages.push({ role: turn.role === "user" ? "user" : "assistant", content: turn.text });
    }
    messages.push({ role: "user", content: userText });

    const res = await axios.post(
      "https://text.pollinations.ai/openai",
      { model: "openai", messages, seed: Date.now() % 9999 },
      { headers: { "Content-Type": "application/json" }, timeout: 25000 }
    );
    const t = res.data?.choices?.[0]?.message?.content?.trim();
    if (t && t.length > 2) return { text: t, source: "pollinations" };
    return null;
  } catch { return null; }
}

// ─── Prompt builder for free providers ───────────────────────
function buildFreePrompt(systemPrompt, history, userText) {
  const lines = [];
  if (systemPrompt) lines.push(`[System]: ${systemPrompt}`, "");
  const recent = history.slice(-8);
  if (recent.length > 0) {
    lines.push("[Conversation so far]:");
    for (const turn of recent) {
      lines.push(`${turn.role === "user" ? "User" : "Bot"}: ${turn.text}`);
    }
    lines.push("");
  }
  lines.push(`User: ${userText}`, "Bot:");
  return lines.join("\n");
}

// ─── Smart AI caller: Gemini → ch.at → pollinations ─────────
const CODE_KEYWORDS = /\b(code|html|css|js|javascript|python|function|script|program|write|create|make|build|show|example|snippet)\b/i;

async function askAI(geminiKey, systemPrompt, history, userText) {
  if (geminiKey && geminiKey.length >= 15) {
    const r = await callGemini(geminiKey, systemPrompt, history, userText);
    if (r) return r;
  }

  // Pollinations POST — full responses, no char limit, no truncation
  return await callPollinations(systemPrompt, history, userText);
}

// ─── Per-session cooldown ─────────────────────────────────────
const cooldowns  = new Map();
const COOLDOWN_MS = 3000; // 3 s between messages

// ═══════════════════════════════════════════════════════════════
//  POST /api/chat   { message, sessionId, geminiKey? }
// ═══════════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  try {
    const { message, sessionId, geminiKey } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ ok: false, error: "Message required." });
    }
    if (!sessionId || typeof sessionId !== "string" || sessionId.length < 8) {
      return res.status(400).json({ ok: false, error: "Valid sessionId required." });
    }

    const text = message.trim().slice(0, 1000);
    const sid  = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

    // Cooldown check
    const now  = Date.now();
    const last = cooldowns.get(sid) || 0;
    if (now - last < COOLDOWN_MS) {
      return res.status(429).json({ ok: false, error: "Too fast — wait a moment ⏳" });
    }
    cooldowns.set(sid, now);
    if (cooldowns.size > 5000) {
      for (const [k, v] of cooldowns) { if (now - v > 60000) cooldowns.delete(k); }
    }

    const lang         = detectLang(text);
    const systemPrompt = buildSystemPrompt(lang);
    const history      = await getHistory(sid);
    const result       = await askAI(geminiKey || "", systemPrompt, history, text);

    if (!result) {
      return res.json({
        ok: true,
        reply:  "❌ AI unavailable right now. Try again in a moment 🙏",
        source: "none",
        lang,
      });
    }

    await appendHistory(sid, "user",  text);
    await appendHistory(sid, "model", result.text);

    res.json({ ok: true, reply: result.text, source: result.source, lang });
  } catch (err) {
    console.error("❌ /api/chat error:", err?.message || err);
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/chat/clear   { sessionId }
// ═══════════════════════════════════════════════════════════════
router.post("/clear", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false });
    await clearHistory(sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/chat/v1   — External API (API key auth)
//  Header: x-api-key: MALIYA-MD-...
//  Body:   { message, sessionId?, model? }
// ═══════════════════════════════════════════════════════════════
import { validateApiKey } from "./models/ApiKey.js";

const extCooldowns = new Map();

router.post("/v1", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"] || req.body?.apiKey;
    if (!apiKey) return res.status(401).json({ ok: false, error: "x-api-key header required." });

    const keyDoc = await validateApiKey(apiKey);
    if (!keyDoc) return res.status(403).json({ ok: false, error: "Invalid or inactive API key." });

    const { message, sessionId } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim())
      return res.status(400).json({ ok: false, error: "message field required." });

    const text = message.trim().slice(0, 1000);
    const sid  = ("ext_" + keyDoc.userId + "_" + (sessionId || "default"))
                   .replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);

    // Cooldown (per API key)
    const now  = Date.now();
    const last = extCooldowns.get(sid) || 0;
    if (now - last < 2000)
      return res.status(429).json({ ok: false, error: "Rate limit — wait 2 s between requests." });
    extCooldowns.set(sid, now);
    if (extCooldowns.size > 2000) {
      for (const [k, v] of extCooldowns) { if (now - v > 60000) extCooldowns.delete(k); }
    }

    const lang         = detectLang(text);
    const systemPrompt = buildSystemPrompt(lang);
    const history      = await getHistory(sid);
    const result       = await askAI("", systemPrompt, history, text);

    if (!result) return res.json({ ok: true, reply: "AI unavailable. Try again.", model: "none" });

    await appendHistory(sid, "user",  text);
    await appendHistory(sid, "model", result.text);

    res.json({ ok: true, reply: result.text, model: result.source, lang });
  } catch (err) {
    console.error("❌ /api/chat/v1 error:", err?.message);
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

export default router;
