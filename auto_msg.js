// ═══════════════════════════════════════════════════════════════
//  auto_msg.js — MALIYA-MD Upgraded AI Chat Plugin
//  ---------------------------------------------------------------
//  ✅ Bot owner .msg on  → ALL private chats get AI replies
//  ✅ Bot owner .msg on all → Groups + private both get AI replies
//  ✅ Bot owner .msg off → Global mode off
//  ✅ No API key needed — free AI (ch.at + pollinations) built-in
//  ✅ Add Gemini key (.setkey) → auto upgrades to Gemini
//  ✅ Fallback chain: Gemini → ch.at → pollinations.ai
// ═══════════════════════════════════════════════════════════════

"use strict";

const { cmd }         = require("../command");
const axios           = require("axios");
const { MongoClient } = require("mongodb");

// ─── Config — reads BOT_OWNER from your config.js / config.env ─
const { BOT_OWNER } = require("../config");
const OWNER_NUMBER = String(BOT_OWNER || process.env.BOT_OWNER || "").replace(/\D/g, "");

// ─── MongoDB ──────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI ||
  "mongodb+srv://MALIYA-MD:279221279221@maliya-md.uzal3aa.mongodb.net/?appName=maliya-md";
const MONGO_DB  = process.env.MONGODB_DB || "maliya_md";

let _client = null;
let _db     = null;

async function getDb() {
  if (_db) return _db;
  _client = new MongoClient(MONGO_URI, { maxPoolSize: 10 });
  await _client.connect();
  _db = _client.db(MONGO_DB);
  console.log("🤖 auto_msg: MongoDB connected");
  return _db;
}

// ─── Key Management ───────────────────────────────────────────
async function getUserDoc(phone) {
  const db = await getDb();
  return db.collection("user_api_keys").findOne({ phone });
}
async function getUserKeys(phone) {
  const doc = await getUserDoc(phone);
  return doc ? (doc.keys || []) : [];
}
async function getUserOwnerName(phone) {
  const doc = await getUserDoc(phone);
  return doc ? (doc.ownerName || "") : "";
}
function isValidApiKey(key) {
  return typeof key === "string" && key.length >= 15 && /^[\w\-\.]+$/.test(key);
}
async function addUserKey(phone, key, ownerName) {
  const db = await getDb();
  const existing = await db.collection("user_api_keys").findOne({ keys: key });
  if (existing && existing.phone !== phone) return { ok: false, reason: "key_taken" };
  const doc  = await getUserDoc(phone);
  const keys = doc ? (doc.keys || []) : [];
  if (keys.includes(key)) return { ok: false, reason: "already_exists" };
  if (keys.length >= 3)   return { ok: false, reason: "limit_reached" };
  await db.collection("user_api_keys").updateOne(
    { phone },
    {
      $push: { keys: key },
      $set:  { ownerName, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  return { ok: true };
}
async function removeUserKey(phone, oneBasedIndex) {
  const db   = await getDb();
  const doc  = await getUserDoc(phone);
  const keys = doc ? [...(doc.keys || [])] : [];
  const idx  = oneBasedIndex - 1;
  if (idx < 0 || idx >= keys.length) return false;
  keys.splice(idx, 1);
  await db.collection("user_api_keys").updateOne(
    { phone },
    { $set: { keys, updatedAt: new Date() } }
  );
  return true;
}

// ─── Global Mode — scoped per bot-owner session ───────────────
// Each bot owner gets their own isolated global_cfg document.
// Key: "global_<ownerPhone>" so one owner's setting never affects another.
async function setGlobalMode(enabled, includeGroups = false, scopePhone = "default") {
  const db  = await getDb();
  const key = `global_${String(scopePhone || "default").replace(/\D/g, "") || "default"}`;
  await db.collection("global_cfg").updateOne(
    { _id: key },
    { $set: { enabled: !!enabled, includeGroups: !!includeGroups, updatedAt: new Date() } },
    { upsert: true }
  );
}
async function getGlobalMode(scopePhone = "default") {
  const db  = await getDb();
  const key = `global_${String(scopePhone || "default").replace(/\D/g, "") || "default"}`;
  const doc = await db.collection("global_cfg").findOne({ _id: key });
  return doc ? { enabled: doc.enabled, includeGroups: doc.includeGroups } : { enabled: false, includeGroups: false };
}

// ─── Per-user Auto-reply toggle + Opt-out ────────────────────
// optedOut = true  → user explicitly turned off (even in global mode)
// optedOut = false → user is active (receives global + personal replies)
async function setAutoReply(phone, enabled) {
  const db = await getDb();
  await db.collection("auto_msg_cfg").updateOne(
    { phone },
    {
      $set: {
        enabled:  !!enabled,
        optedOut: !enabled,   // off = opted out, on = not opted out
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}
async function isAutoReplyEnabled(phone) {
  const db  = await getDb();
  const doc = await db.collection("auto_msg_cfg").findOne({ phone });
  return doc ? doc.enabled : false;
}
async function isOptedOut(phone) {
  const db  = await getDb();
  const doc = await db.collection("auto_msg_cfg").findOne({ phone });
  return doc ? (doc.optedOut === true) : false;
}

// ─── Chat History ─────────────────────────────────────────────
const HISTORY_MAX = 20;
async function getHistory(phone) {
  const db  = await getDb();
  const doc = await db.collection("chat_history").findOne({ phone });
  return doc ? (doc.messages || []) : [];
}
async function appendHistory(phone, role, text) {
  const db   = await getDb();
  const turn = { role, text: String(text).slice(0, 2000), ts: Date.now() };
  await db.collection("chat_history").updateOne(
    { phone },
    {
      $push: { messages: { $each: [turn], $slice: -HISTORY_MAX } },
      $set:  { updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}
async function clearHistory(phone) {
  const db = await getDb();
  await db.collection("chat_history").updateOne(
    { phone },
    { $set: { messages: [], updatedAt: new Date() } },
    { upsert: true }
  );
}

// ─── Language Detection ───────────────────────────────────────
// Returns: "si" (Sinhala Unicode) | "singlish" | "ta" (Tamil) | "en"
const SI_UNICODE  = /[\u0D80-\u0DFF]/;
const TA_UNICODE  = /[\u0B80-\u0BFF]/;
const SINGLISH_KW = [
  "mata","oya","mage","mokak","mokada","kohomada","karanna","puluwan",
  "thiyenawa","wenawa","kiyanne","kiyala","ane","machan","bro","ganna",
  "danna","hadanne","thiyanawa","wela","neda","api","eka","epa","wenna",
  "balanna","thawa","honda","tikak","godak","oyata","meka","oyage","meka",
  "kawda","kawruwat","mona","hari","naha","inne","hitiye","giye","aawa",
  "gawa","danne","thene","wenne","denne","lassana","honda","nangi","aiya",
  "akka","ayye","malli","duwa","putha","ammae","thaathae","apita","apige",
];
function detectLang(text) {
  if (SI_UNICODE.test(text))  return "si";        // Sinhala Unicode chars
  if (TA_UNICODE.test(text))  return "ta";        // Tamil Unicode chars
  const lower = text.toLowerCase();
  if (SINGLISH_KW.some((w) => lower.includes(w))) return "singlish"; // Sinhala in Roman
  return "en";
}

// ─── System Prompt ────────────────────────────────────────────
function buildSystemPrompt(ownerName, pushName, lang) {
  const who  = ownerName ? `${ownerName}ge MALIYA-MD WhatsApp Bot` : "MALIYA-MD WhatsApp Bot";
  const whoSi = ownerName ? `${ownerName}ගේ MALIYA-MD WhatsApp Bot` : "MALIYA-MD WhatsApp Bot";
  const user = pushName && pushName.trim() ? pushName.trim() : "user";

  // Singlish: reply in Singlish (Sinhala words written in Roman/English letters)
  if (lang === "singlish") {
    return (
      `Oya ${who}. Oya manage karanney ${ownerName || "Bot Owner"}.` +
      ` Dan chat karana kenage nam ${user}. Ovunta ${user} kiyala address karanna.` +
      ` වැදගත්: Reply karanna Singlish walin — Sinhala words Roman letters walin liyanna (Sinhala Unicode use karagannna epa!).` +
      ` Example: "kohomada ${user}? 😊 mokak karannada?"` +
      ` Emojis use karanna replies walata. Short, friendly, natural chat style.` +
      ` Previous conversation context use karala relevant replies denna.`
    );
  }

  // Sinhala Unicode: reply fully in Sinhala Unicode
  if (lang === "si") {
    return (
      `ඔයා ${whoSi}. ඔයාව manage කරන්නේ ${ownerName || "Bot Owner"}.` +
      ` දැන් chat කරන කෙනාගේ නම ${user}. ඔවුන්ව ${user} කියලා address කරන්න.` +
      ` වැදගත්: සෑම reply එකක්ම සම්පූර්ණ *සිංහල Unicode* ගෙන් ලියන්න — Singlish use කරන්නෙ නෑ.` +
      ` Emojis use කරන්න replies වලට. Short, friendly, natural chat style.` +
      ` කලින් conversation context use කරලා relevant replies දෙන්න.`
    );
  }

  // Tamil
  if (lang === "ta") {
    return (
      `நீங்கள் ${ownerName ? `${ownerName}இன் MALIYA-MD WhatsApp Bot` : "MALIYA-MD WhatsApp Bot"}.` +
      ` இப்போது பேசுபவரின் பெயர் ${user}. அவர்களை ${user} என்று அழையுங்கள்.` +
      ` IMPORTANT: தமிழில் மட்டும் பதில் சொல்லுங்கள். Emojis பயன்படுத்துங்கள். குறுகியதாக, நட்பாக பேசுங்கள்.` +
      ` முந்தைய உரையாடல் context பயன்படுத்தி பதில் சொல்லுங்கள்.`
    );
  }

  // English (default)
  return (
    `You are ${who}. The person chatting is named ${user}. Address them as ${user} naturally.` +
    ` IMPORTANT: Reply ONLY in English. Use emojis to make replies feel warm and expressive.` +
    ` Be short, friendly, and conversational.` +
    ` Use the previous conversation history for context when replying.`
  );
}

// ══════════════════════════════════════════════════════════════
//  FREE AI PROVIDERS
// ══════════════════════════════════════════════════════════════

async function callChAt(prompt, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.post(
        "https://ch.at/api/chat",
        { message: prompt },
        { headers: { "Content-Type": "application/json", "User-Agent": "MALIYA-MD-Bot/2.0" }, timeout: 12000 }
      );
      const t = res.data?.answer || res.data?.reply || res.data?.message ||
                res.data?.response || res.data?.result;
      if (t && String(t).trim().length > 2) return { text: String(t).trim(), source: "ch.at" };
    } catch (_) {}
    if (i < retries) await new Promise(r => setTimeout(r, 500 * i));
  }
  return null;
}

async function callPollinations(prompt) {
  try {
    const res = await axios.get(
      "https://text.pollinations.ai/" + encodeURIComponent(prompt.slice(0, 500)) +
      "?model=openai&seed=" + (Date.now() % 9999),
      { timeout: 18000 }
    );
    const t = typeof res.data === "string" ? res.data.trim() : null;
    if (t && t.length > 2) return { text: t, source: "pollinations" };
    return null;
  } catch { return null; }
}

const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"];

async function callGemini(apiKey, systemPrompt, history, userText) {
  const contents = [];
  contents.push({ role: "user",  parts: [{ text: systemPrompt }] });
  contents.push({ role: "model", parts: [{ text: "Understood." }] });
  for (const turn of history) {
    contents.push({ role: turn.role === "user" ? "user" : "model", parts: [{ text: turn.text }] });
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

// Build a text-based conversation prompt for free AI providers
// Includes up to last 8 history turns so the AI has full context
function buildFreePrompt(systemPrompt, history, userText) {
  const lines = [];
  if (systemPrompt) lines.push(`[System]: ${systemPrompt}`);
  lines.push("");

  // Include last 8 turns of history (older → newer)
  const recent = history.slice(-8);
  if (recent.length > 0) {
    lines.push("[Conversation so far]:");
    for (const turn of recent) {
      const role = turn.role === "user" ? "User" : "Bot";
      lines.push(`${role}: ${turn.text}`);
    }
    lines.push("");
  }

  lines.push(`User: ${userText}`);
  lines.push("Bot:");
  return lines.join("\n");
}

// Smart caller: Gemini → ch.at → pollinations
async function askAI(phone, systemPrompt, history, userText) {
  const keys = await getUserKeys(phone);
  if (keys.length) {
    for (const key of keys) {
      const result = await callGemini(key, systemPrompt, history, userText);
      if (result) return result;
    }
  }
  // Free providers — include history in the text prompt
  const freePrompt = buildFreePrompt(systemPrompt, history, userText);
  const chAtResult = await Promise.race([
    callChAt(freePrompt),
    new Promise(r => setTimeout(() => r(null), 14000)),
  ]);
  if (chAtResult) return chAtResult;
  return await callPollinations(freePrompt);
}

// ─── Helpers ──────────────────────────────────────────────────
const THINKING_REACTS = [
  "🤔","💭","⏳","🔍","✨","🧠","🌀","⚙️","🔄","💡",
  "🕵️","📡","🛸","🔬","🧩","🌊","🎯","🔮","💫","🌙",
  "🤖","📟","🧬","🔭","💻","⌛","🕐","🧪","🗂️","📊",
  "🌐","📡","🎲","🧿","🔑","🗺️","📌","🏹","🌌","🔒",
  "⚗️","🧲","💠","🔵","🟣","🌀","🎴","🀄","🎮","🕹️",
];

const REPLY_REACTS = [
  "❤️","🔥","😊","👍","💫","🌟","🎯","⚡","🥰","💕",
  "😍","🤩","💯","🏆","👑","✅","🎉","🎊","🙌","👏",
  "💪","🚀","✨","🌈","💎","🦋","🌸","🌺","🌻","🌹",
  "🍀","🎀","🎁","🎵","🎶","🎸","🥳","🤗","😎","🦁",
  "🐯","🦊","🦄","🐉","⭐","🌠","💥","🎆","🎇","🪄",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
async function react(conn, mek, emoji) {
  try { await conn.sendMessage(mek.key.remoteJid, { react: { text: emoji, key: mek.key } }); } catch (_) {}
}
function failMsg(lang) {
  if (lang === "si")       return "❌ AI service unavailable. ටිකක් wait කරලා try කරන්න. 🙏\n> MALIYA-MD ❤️";
  if (lang === "singlish") return "❌ AI service epa wela. Tikak wait karala try karanna 🙏\n> MALIYA-MD ❤️";
  if (lang === "ta")       return "❌ AI சேவை இல்லை. சிறிது நேரம் கழித்து முயற்சிக்கவும் 🙏\n> MALIYA-MD ❤️";
  return "❌ AI unavailable right now. Try again later 🙏\n> MALIYA-MD ❤️";
}

// ─── Is sender the bot owner? ─────────────────────────────────
function isOwner(phone, sessionOwnerPhone) {
  const clean = String(phone || "").replace(/\D/g, "");
  if (OWNER_NUMBER && clean === OWNER_NUMBER)      return true;
  if (sessionOwnerPhone && clean === String(sessionOwnerPhone).replace(/\D/g, "")) return true;
  return false;
}

// ══════════════════════════════════════════════════════════════
//  COMMANDS
// ══════════════════════════════════════════════════════════════

// .setkey — optional Gemini upgrade
cmd({
  pattern: "setkey",
  desc:    "Add Gemini API key (optional — upgrades AI quality)",
  type:    "all",
  react:   "🔑",
}, async (conn, mek, m, { args, sender, pushName }) => {
  const phone = sender.split("@")[0].replace(/\D/g, "");
  const key   = (args[0] || "").trim();
  const lang  = detectLang(m.body || "");
  if (!isValidApiKey(key)) {
    return m.reply(lang === "si"
      ? "❌ Invalid key.\n*.setkey <your_key>*\nFree: https://aistudio.google.com/apikey\n> MALIYA-MD ❤️"
      : "❌ Invalid key.\n*.setkey <your_key>*\nFree: https://aistudio.google.com/apikey\n> MALIYA-MD ❤️");
  }
  const result = await addUserKey(phone, key, pushName || phone);
  if (!result.ok) {
    const msgs = {
      key_taken:      "❌ Key is registered to another user.\n> MALIYA-MD ❤️",
      already_exists: "⚠️ Key already saved.\n> MALIYA-MD ❤️",
      limit_reached:  "❌ Max 3 keys. Use *.removekey <n>* first.\n> MALIYA-MD ❤️",
    };
    return m.reply(msgs[result.reason] || "❌ Error saving key.\n> MALIYA-MD ❤️");
  }
  m.reply("✅ *Gemini API key saved!*\n🚀 AI upgraded to Gemini.\n> MALIYA-MD ❤️");
});

// .removekey
cmd({
  pattern: "removekey",
  desc:    "Remove a saved API key",
  type:    "all",
  react:   "🗑️",
}, async (conn, mek, m, { args, sender }) => {
  const phone = sender.split("@")[0].replace(/\D/g, "");
  const num   = parseInt(args[0]);
  if (!num || num < 1 || num > 3) return m.reply("Usage: *.removekey <1-3>*\n> MALIYA-MD ❤️");
  const ok = await removeUserKey(phone, num);
  m.reply(ok ? "✅ Key removed.\n> MALIYA-MD ❤️" : "❌ Key not found.\n> MALIYA-MD ❤️");
});

// .mykeys
cmd({
  pattern: "mykeys",
  desc:    "List your saved Gemini API keys",
  type:    "all",
  react:   "🔑",
}, async (conn, mek, m, { sender }) => {
  const phone = sender.split("@")[0].replace(/\D/g, "");
  const keys  = await getUserKeys(phone);
  if (!keys.length) {
    return m.reply("ℹ️ No Gemini keys.\nFree AI is active.\n*.setkey <key>* — Upgrade\n> MALIYA-MD ❤️");
  }
  const list = keys.map((k, i) => `*${i + 1}.* \`${k.slice(0, 8)}...${k.slice(-4)}\``).join("\n");
  m.reply(`🔑 *Gemini Keys (${keys.length}/3)*\n\n${list}\n\n> MALIYA-MD ❤️`);
});

// .msg on | off | status | clear
cmd({
  pattern: "msg",
  desc:    "AI auto-reply — oma eka on/off karanna",
  type:    "all",
  react:   "🤖",
}, async (conn, mek, m, { args, sender }) => {
  const phone = sender.split("@")[0].replace(/\D/g, "");
  const sub   = (args[0] || "").toLowerCase().trim();

  // ── .msg on → this user opts in ──────────────────────────
  if (sub === "on") {
    await setAutoReply(phone, true);
    const keys   = await getUserKeys(phone);
    const source = keys.length ? "🚀 Gemini AI" : "⚡ Free AI (ch.at + pollinations)";
    return m.reply(
      `✅ *AI Auto Reply ON* 🤖\n` +
      `🧠 ${source}\n\n` +
      `> Dan oya kiyana ekka AI reply karanawa!\n` +
      `> Off karanna: *.msg off*\n` +
      `> MALIYA-MD ❤️`
    );
  }

  // ── .msg off → this user opts out ────────────────────────
  if (sub === "off") {
    await setAutoReply(phone, false);
    return m.reply(
      `⛔ *AI Auto Reply OFF*\n\n` +
      `> Wapas on karanna: *.msg on*\n` +
      `> MALIYA-MD ❤️`
    );
  }

  // ── .msg clear ────────────────────────────────────────────
  if (sub === "clear") {
    await clearHistory(phone);
    return m.reply("🗑️ Chat history cleared.\n> MALIYA-MD ❤️");
  }

  // ── .msg status ───────────────────────────────────────────
  if (sub === "status") {
    const global   = await getGlobalMode(scopePhone);
    const keys     = await getUserKeys(phone);
    const userOn   = await isAutoReplyEnabled(phone);
    const optedOut = await isOptedOut(phone);
    const history  = await getHistory(phone);
    const source   = keys.length ? `🚀 Gemini (${keys.length} key/s)` : "⚡ Free AI (ch.at + pollinations)";

    // What actually happens to THIS user
    let myStatus;
    if (global.enabled && optedOut)  myStatus = "OFF ⛔ (personally opted out)";
    else if (global.enabled)         myStatus = "ON ✅ (via global mode)";
    else if (userOn)                 myStatus = "ON ✅ (personal)";
    else                             myStatus = "OFF ⛔";

    return m.reply(
      `📊 *AI Status*\n\n` +
      `🌐 Global Mode : ${global.enabled ? "ON ✅" : "OFF ⛔"}\n` +
      `👥 Groups      : ${global.includeGroups ? "ON ✅" : "OFF ⛔"}\n` +
      `🤖 My AI       : ${myStatus}\n` +
      `🧠 AI Source   : ${source}\n` +
      `💬 History     : ${history.length} turns\n` +
      `> MALIYA-MD ❤️`
    );
  }

  // ── Help ──────────────────────────────────────────────────
  m.reply(
    `🤖 *AI Chat Commands*\n\n` +
    `*.msg on*          — Oma eka private AI on\n` +
    `*.msg on all*      — *Okkotama* (private + groups) AI on 🌐\n` +
    `*.msg off*         — Oma eka AI off\n` +
    `*.msg global off*  — Okkoma global AI off\n` +
    `*.msg clear*       — History clear\n` +
    `*.msg status*      — Status check\n\n` +
    `*.setkey <key>*    — Gemini key add (optional upgrade)\n` +
    `*.mykeys*          — Keys list\n` +
    `*.removekey <n>*   — Key remove\n\n` +
    `💡 API key nathi wath free AI (ch.at + pollinations) use weyyi.\n` +
    `> MALIYA-MD ❤️`
  );
});

// ══════════════════════════════════════════════════════════════
//  AUTO-REPLY HANDLER
// ══════════════════════════════════════════════════════════════
const _cooldowns = new Map();
const COOLDOWN_MS = 8000;

async function handleAutoMsg({ conn, mek, m, sender, pushName, body, isGroup, sessionOwnerPhone, sessionOwnerName }) {
  try {
    if (!body || body.startsWith(".")) return false;

    const phone = String(sender || "").split("@")[0].replace(/\D/g, "");
    if (!phone) return false;

    // Don't reply to bot's own messages
    const botJidPhone = (conn.user?.id || "").split(":")[0].split("@")[0].replace(/\D/g, "");
    if (botJidPhone && phone === botJidPhone) return false;
    if (mek?.key?.fromMe)                    return false;

    // Owner's own messages — never auto-reply to owner
    const senderIsOwner = isOwner(phone, sessionOwnerPhone);
    if (senderIsOwner) return false;

    // Strictly per-user opt-in — no global force mode
    // Groups never get auto-replies
    if (isGroup) return false;
    const shouldReply = await isAutoReplyEnabled(phone);
    if (!shouldReply) return false;

    // ── Cooldown ─────────────────────────────────────────────
    const cooldownKey = isGroup ? (mek.key?.remoteJid + phone) : phone;
    const now  = Date.now();
    const last = _cooldowns.get(cooldownKey) || 0;
    if (now - last < COOLDOWN_MS) return false;
    _cooldowns.set(cooldownKey, now);

    await react(conn, mek, pick(THINKING_REACTS));

    const lang = detectLang(body);

    const effectivePushName =
      (pushName && pushName.trim())          ? pushName.trim()     :
      (mek?.pushName && mek.pushName.trim()) ? mek.pushName.trim() : "";

    const storedOwner  = await getUserOwnerName(phone);
    const ownerName    = sessionOwnerName || storedOwner || "Bot Owner";
    const systemPrompt = buildSystemPrompt(ownerName, effectivePushName, lang);
    const history      = await getHistory(phone);

    // AI call — Gemini (user key) → ch.at → pollinations
    const result = await askAI(phone, systemPrompt, history, body);

    if (!result) {
      await react(conn, mek, "❌");
      await conn.sendMessage(m.chat, { text: failMsg(lang) }, { quoted: mek });
      return true;
    }

    await appendHistory(phone, "user",  body);
    await appendHistory(phone, "model", result.text);
    await react(conn, mek, pick(REPLY_REACTS));

    // Send (split if long)
    const MAX_LEN = 3500;
    if (result.text.length <= MAX_LEN) {
      await conn.sendMessage(m.chat, { text: result.text }, { quoted: mek });
    } else {
      let rem = result.text;
      while (rem.length > 0) {
        let cut = rem.lastIndexOf("\n", MAX_LEN);
        if (cut < 800) cut = rem.lastIndexOf(". ", MAX_LEN);
        if (cut < 800) cut = MAX_LEN;
        const chunk = rem.slice(0, cut).trim();
        if (chunk) await conn.sendMessage(m.chat, { text: chunk }, { quoted: mek });
        rem = rem.slice(cut).trim();
      }
    }

    return true;
  } catch (err) {
    console.error("❌ auto_msg error:", err?.message || err);
    return false;
  }
}

module.exports = { handleAutoMsg };

// ══════════════════════════════════════════════════════════════
//  HOW TO INTEGRATE IN index.js
//  -----------------------------------------------------------
//  1. Set owner number in your bot config/env:
//       process.env.OWNER_NUMBER = "94711234567"  // digits only
//
//  2. Import at top of index.js:
//       const { handleAutoMsg } = require("./plugins/auto_msg");
//
//  3. Inside messages.upsert handler, after command processing:
//       const handled = await handleAutoMsg({
//         conn, mek, m, sender, pushName, body,
//         isGroup, sessionOwnerPhone, sessionOwnerName,
//       });
//       if (handled) return;
// ══════════════════════════════════════════════════════════════
