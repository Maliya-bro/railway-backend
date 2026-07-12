// ╔══════════════════════════════════════════════════════════════╗
//  MALIYA-MD — Multi-User WhatsApp Bot  (index.js)
//  Integrated: auto_msg plugin with per-user Gemini key support
// ╚══════════════════════════════════════════════════════════════╝

/* ==================== GLOBAL CRASH GUARD ==================== */
process.on("unhandledRejection", (reason) => {
  const msg = String(reason?.message || reason || "");
  if (
    msg.includes("Bad MAC") ||
    msg.includes("Failed to decrypt") ||
    msg.includes("Stream Errored") ||
    msg.includes("Connection Closed") ||
    msg.includes("Connection Lost") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT")
  ) {
    console.log("⚠️ Non-fatal rejection suppressed:", msg.slice(0, 120));
    return;
  }
  console.error("❌ Unhandled Rejection:", msg);
});

process.on("uncaughtException", (err) => {
  const msg = String(err?.message || err || "");
  if (
    msg.includes("Bad MAC") ||
    msg.includes("Failed to decrypt") ||
    msg.includes("Stream Errored") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT")
  ) {
    console.log("⚠️ Non-fatal exception suppressed:", msg.slice(0, 120));
    return;
  }
  console.error("❌ Uncaught Exception:", msg);
});

/* ==================== IMPORTS ==================== */
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  getContentType,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");

const fs      = require("fs");
const P       = require("pino");
const express = require("express");
const path    = require("path");
const { MongoClient } = require("mongodb");

const config            = require("./config");
const { readSettings }  = require("./lib/botSettings");
const { sms }           = require("./lib/msg");
const { commands, replyHandlers } = require("./command");

// ── Plugins ──────────────────────────────────────────────────
// NEW: per-user Gemini key plugin
const { handleAutoMsg } = require("./plugins/auto_msg.js");

const autoReactPlugin   = require("./plugins/auto-react.js");

let pdfScannerPlugin = null;
try {
  pdfScannerPlugin = require("./plugins/PDF scanner.js");
} catch (e) {
  console.log("⚠️ PDF scanner.js not found:", e?.message || e);
}

let cmdFixPlugin = null;
try {
  cmdFixPlugin = require("./plugins/cmd_autofix_confirm.js");
} catch (e) {
  console.log("⚠️ cmd_autofix_confirm.js not found:", e?.message || e);
}

const app  = express();
const port = process.env.PORT || 8000;

const prefix         = ".";
const BOT_OWNER_NAME = config.OWNER_NAME || "Malindu Nadith";
const baseOwnerNumber = [String(config.BOT_OWNER || "").replace(/\D/g, "")].filter(Boolean);
const sessionsBaseDir = path.join(__dirname, "multi_auth_sessions");
const MAX_ACTIVE_SESSIONS = Number(process.env.MAX_ACTIVE_SESSIONS || 50);

/* ==================== MONGODB ==================== */
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://MALIYA-MD:279221@maliya-md.uzal3aa.mongodb.net/?appName=maliya-md";

console.log("🔗 MongoDB URI in use:", MONGODB_URI.replace(/:([^@]+)@/, ":****@"));

const MONGODB_DB       = process.env.MONGODB_DB       || "maliya_md";
const SESSION_COLLECTION = process.env.SESSION_COLLECTION || "wa_sessions";

let cachedClient = null;
let cachedDb     = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  cachedClient = new MongoClient(MONGODB_URI, { maxPoolSize: 30 });
  await cachedClient.connect();
  cachedDb = cachedClient.db(MONGODB_DB);
  console.log("✅ Connected to MongoDB");
  return cachedDb;
}

function normalizeSessionId(value) {
  return String(value || "").trim();
}

function safeSessionFolderName(sessionId) {
  return String(sessionId || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 150);
}

async function getSessionById(sessionId) {
  const db  = await getDb();
  const col = db.collection(SESSION_COLLECTION);
  return col.findOne({ sessionId: normalizeSessionId(sessionId) });
}

async function getConnectableSessions(limit = MAX_ACTIVE_SESSIONS) {
  const db  = await getDb();
  const col = db.collection(SESSION_COLLECTION);
  return col
    .find({
      connectBot:  true,
      status:      { $nin: ["logged_out", "deleted", "disabled"] },
      primaryFile: { $exists: true },
    })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(limit)
    .toArray();
}

async function updateSessionStatus(sessionId, data = {}) {
  if (!sessionId) return;
  try {
    const db  = await getDb();
    const col = db.collection(SESSION_COLLECTION);
    await col.updateOne(
      { sessionId: normalizeSessionId(sessionId) },
      { $set: { ...data, updatedAt: new Date() } }
    );
  } catch (e) {
    console.log("Session status update error:", e?.message || e);
  }
}

async function restoreCredsToFile(sessionId, targetFilePath) {
  const doc = await getSessionById(sessionId);
  if (!doc)                 throw new Error(`Session not found in MongoDB: ${sessionId}`);
  if (!doc.primaryFile?.data) throw new Error(`No primaryFile.data for session: ${sessionId}`);
  fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
  fs.writeFileSync(targetFilePath, Buffer.from(doc.primaryFile.data, "base64"));
  return targetFilePath;
}

/* ==================== PLUGINS LOADER ==================== */
const antiDeletePlugin = require("./plugins/antidelete.js");

global.pluginHooks = global.pluginHooks || [];
global.pluginHooks.push(antiDeletePlugin);

let pluginsLoaded = false;

function loadCommandPluginsOnce() {
  if (pluginsLoaded) return;
  pluginsLoaded = true;
  try {
    fs.readdirSync("./plugins/").forEach((plugin) => {
      if (plugin === "auto_msg.js")  return;  // handled separately
      if (plugin === "antidelete.js") return;
      if (plugin.endsWith(".js")) {
        require(`./plugins/${plugin}`);
      }
    });
    console.log("✅ Command plugins loaded");
  } catch (e) {
    console.log("⚠️ Plugin load error:", e?.message || e);
  }
}

loadCommandPluginsOnce();

/* ==================== HELPERS ==================== */
function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function getBodyFromMessage(message) {
  if (!message) return "";

  const direct =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedButtonId ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.templateButtonReplyMessage?.selectedId ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    message.listResponseMessage?.title ||
    message.interactiveResponseMessage?.body?.text ||
    "";

  if (direct) return String(direct).trim();

  const paramsJson =
    message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;

  if (paramsJson) {
    const parsed = safeJsonParse(paramsJson);
    if (parsed) {
      return String(
        parsed.id || parsed.selectedId || parsed.selectedRowId ||
        parsed.title || parsed.display_text || parsed.text ||
        parsed.name || paramsJson
      ).trim();
    }
    return String(paramsJson).trim();
  }

  return "";
}

/* ==================== MULTI-SESSION MANAGER ==================== */
const activeSessions  = new Map();
const reconnectTimers = new Map();
let   watcherStarted  = false;

function getSessionPaths(sessionId) {
  const safeId  = safeSessionFolderName(sessionId);
  const authDir = path.join(sessionsBaseDir, safeId);
  const credsPath = path.join(authDir, "creds.json");
  return { authDir, credsPath, safeId };
}

function getOwnerNumberForSock(sock) {
  const jid    = sock.user?.id || "";
  const number = String(jid).split("@")[0].split(":")[0].replace(/\D/g, "");
  return number ? [number] : [...baseOwnerNumber];
}

async function cleanupSessionFolder(sessionId) {
  try {
    const { authDir } = getSessionPaths(sessionId);
    fs.rmSync(authDir, { recursive: true, force: true });
  } catch (_) {}
}

async function scheduleReconnect(sessionId, delayMs = 5000) {
  if (!sessionId)                        return;
  if (reconnectTimers.has(sessionId))    return;

  const timer = setTimeout(async () => {
    reconnectTimers.delete(sessionId);
    if (activeSessions.has(sessionId))  return;
    console.log(`🔁 Reconnecting session ${sessionId}...`);
    await startSessionBot(sessionId);
  }, delayMs);

  reconnectTimers.set(sessionId, timer);
}

async function startSessionBot(sessionId) {
  sessionId = normalizeSessionId(sessionId);
  if (!sessionId) return null;

  if (activeSessions.has(sessionId))     return activeSessions.get(sessionId);

  if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
    console.log(`⚠️ Active session limit reached (${MAX_ACTIVE_SESSIONS}). Skipping ${sessionId}`);
    return null;
  }

  const { authDir, credsPath } = getSessionPaths(sessionId);

  try {
    fs.mkdirSync(authDir, { recursive: true });
    await restoreCredsToFile(sessionId, credsPath);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version }          = await fetchLatestBaileysVersion();

    const sessionCtx = {
      sessionId,
      authDir,
      credsPath,
      ownerNumber: [...baseOwnerNumber],
      connected:   false,
      connecting:  true,
      sock:        null,
    };

    const sock = makeWASocket({
      logger:                       P({ level: "silent" }),
      printQRInTerminal:            false,
      browser:                      Browsers.macOS("Firefox"),
      auth:                         state,
      version,
      syncFullHistory:              true,
      markOnlineOnConnect:          true,
      generateHighQualityLinkPreview: true,
    });

    sessionCtx.sock = sock;
    activeSessions.set(sessionId, sessionCtx);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          sessionCtx.connected    = true;
          sessionCtx.connecting   = false;
          sessionCtx.ownerNumber  = getOwnerNumberForSock(sock);

          await updateSessionStatus(sessionId, {
            status:     "connected",
            connectBot: true,
            botJid:     sock.user?.id || null,
          });

          console.log(`✅ Session connected: ${sessionId}`);

          // ── Connect message ──────────────────────────────
          const now  = new Date();
          const time = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Colombo", hour: "2-digit", minute: "2-digit",
            second: "2-digit", hour12: true,
          }).format(now);
          const date = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Colombo", year: "numeric",
            month: "2-digit", day: "2-digit",
          }).format(now);

          const BOT_VERSION = "v4.0.0";
          const up = `
🌈━━━━━━━━━━━━━🌈
🔥🤖 *MALIYA-MD* 🤖🔥
🌈━━━━━━━━━━━━━🌈

✅✨ Connection : CONNECTED & ONLINE
⚡🧬 System     : STABLE | FAST | SECURE
🛡️🔐 Mode      : ${String(readSettings().mode || "public").toUpperCase()}
🎯🧩 Prefix    : ${prefix}

🧑‍💻👑 Owner    : ${BOT_OWNER_NAME}
🚀📦 Version  : ${BOT_VERSION}

🕒⏳ Time      : ${time}
📅🗓️ Date      : ${date}

💬📖 Type .menu to start
🔥🚀 Powered by MALIYA-MD Engine
🌈━━━━━━━━━━━🌈`.trim();

          try {
            if (sessionCtx.ownerNumber[0]) {
              await sock.sendMessage(sessionCtx.ownerNumber[0] + "@s.whatsapp.net", {
                image: {
                  url: "https://raw.githubusercontent.com/Maliya-bro/MALIYA-MD/refs/heads/main/images/ChatGPT%20Image%20Jan%2018%2C%202026%2C%2012_27_25%20PM.png",
                },
                caption: up,
              });
            }
          } catch (e) {
            console.log("⚠️ Connect msg send failed:", e?.message || e);
          }
        }

        if (connection === "close") {
          sessionCtx.connected  = false;
          sessionCtx.connecting = false;

          const code = lastDisconnect?.error?.output?.statusCode;
          activeSessions.delete(sessionId);

          if (code !== DisconnectReason.loggedOut) {
            console.log(`🔁 Session disconnected, reconnecting: ${sessionId}`);
            await updateSessionStatus(sessionId, {
              status:     "disconnected",
              connectBot: true,
            });
            await scheduleReconnect(sessionId, 5000);
          } else {
            console.log(`❌ Session logged out: ${sessionId}`);
            await updateSessionStatus(sessionId, {
              status:     "logged_out",
              connectBot: false,
            });
            await cleanupSessionFolder(sessionId);
          }
        }
      } catch (e) {
        console.log("⚠️ connection.update handler error:", e?.message || e);
      }
    });

    attachSessionHandlers(sock, sessionCtx);

    await updateSessionStatus(sessionId, {
      status:     "connecting",
      connectBot: true,
    });

    return sessionCtx;
  } catch (e) {
    console.log(`❌ Failed to start session ${sessionId}:`, e?.message || e);
    activeSessions.delete(sessionId);
    await updateSessionStatus(sessionId, {
      status:    "connect_error",
      lastError: String(e?.message || e),
    });
    return null;
  }
}

async function ensureConfiguredSession() {
  if (!config.SESSION_ID) return;
  await startSessionBot(config.SESSION_ID);
}

function startSessionWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;

  const tick = async () => {
    try {
      const db  = await getDb();
      const col = db.collection(SESSION_COLLECTION);

      const docs = await col.find({
        connectBot:  true,
        primaryFile: { $exists: true },
      }).toArray();

      console.log(
        `🔍 Watcher tick: found ${docs.length} session(s) in DB [${MONGODB_DB}/${SESSION_COLLECTION}]`
      );

      for (const doc of docs) {
        const id = doc.sessionId;
        if (!id)                      continue;
        if (activeSessions.has(id))   continue;
        console.log("🔌 Connecting NEW session:", id);
        await startSessionBot(id);
      }
    } catch (e) {
      console.log("Watcher tick error:", e?.message || e);
    }
  };

  tick();
  setInterval(tick, 5000);
}

/* ==================== SESSION MESSAGE HANDLERS ==================== */
function attachSessionHandlers(sock, sessionCtx) {

  // ── Call reject ─────────────────────────────────────────────
  sock.ev.on("call", async (calls) => {
    try {
      const settings = readSettings();
      if (!settings.auto_reject_calls) return;

      for (const call of calls) {
        const callId   = call.id;
        const callerId = call.from;
        if (!callId || !callerId) continue;
        try {
          await sock.rejectCall(callId, callerId);
          await sock.sendMessage(callerId, {
            text: "❌ Calls are not allowed on this bot.",
          });
        } catch (e) {
          console.log("Call reject error:", e?.message || e);
        }
      }
    } catch (e) {
      console.log("Call event error:", e?.message || e);
    }
  });

  // ── Main message handler ─────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!messages || !messages.length) return;

    messageLoop: for (const mek of messages) {
      try {
        if (!mek?.message) continue messageLoop;

        mek.message =
          getContentType(mek.message) === "ephemeralMessage"
            ? mek.message.ephemeralMessage.message
            : mek.message;

        // ── pluginHooks (antidelete, etc.) ───────────────────
        if (global.pluginHooks) {
          for (const plugin of global.pluginHooks) {
            if (plugin.onMessage) {
              try { await plugin.onMessage(sock, mek); } catch (_) {}
            }
          }
        }

        // ── Status handling ──────────────────────────────────
        if (
          mek.key &&
          mek.key.remoteJid === "status@broadcast" &&
          !mek.message?.reactionMessage
        ) {
          const participantRaw = mek.key.participant;
          const id             = mek.key.id;
          if (!participantRaw || !id) continue messageLoop;
          const participant = participantRaw;
          if (mek.key.fromMe) continue messageLoop;

          // Auto seen
          if (readSettings().auto_status_seen === true) {
            try {
              await sock.readMessages([mek.key]);
              console.log(`[✓] Status seen: ${id} (${participant})`);
            } catch (e) {
              console.error("❌ Seen error:", e?.message || e);
            }
          }

          // Dedup
          const processedStatuses = global.processedStatuses || new Map();
          global.processedStatuses = processedStatuses;
          const uniqueStatusId = `${participant}:${id}`;
          const now = Date.now();
          if (processedStatuses.has(uniqueStatusId)) {
            if (now - processedStatuses.get(uniqueStatusId) < 300000)
              continue messageLoop;
          }
          processedStatuses.set(uniqueStatusId, now);
          setTimeout(() => processedStatuses.delete(uniqueStatusId), 300000);

          // Auto react
          if (readSettings().auto_status_react === true) {
            try {
              const emojis = [
                "😎","🔥","⚡","👑","💯","💎","🚀","😈",
                "💔","🥺","😔","😭","🥀","😞","🌧️","❤️‍🩹",
                "😂","🤣","🤡","💀","🗿","😜","🙈","🍿",
                "❤️","✨","🌈","🎶","🌟","🎧",
              ];
              const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
              await new Promise((r) => setTimeout(r, 1500));
              try {
                await sock.sendMessage(
                  "status@broadcast",
                  { react: { text: randomEmoji, key: mek.key } },
                  { statusJidList: [participant] }
                );
                console.log(`[✓] Reacted (new): ${participant} ${randomEmoji}`);
              } catch {
                await sock.sendMessage(participant, {
                  react: { text: randomEmoji, key: mek.key },
                });
                console.log(`[✓] Reacted (fallback): ${participant} ${randomEmoji}`);
              }
            } catch (e) {
              console.error("❌ React error:", e?.message || e);
            }
          }

          // Auto download + forward to owner
          if (
            readSettings().auto_download_status === true &&
            (mek.message?.imageMessage || mek.message?.videoMessage)
          ) {
            try {
              const msgType = mek.message.imageMessage ? "imageMessage" : "videoMessage";
              const mediaMsg = mek.message[msgType];
              const stream   = await downloadContentFromMessage(
                mediaMsg, msgType === "imageMessage" ? "image" : "video"
              );
              let buffer = Buffer.from([]);
              for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
              const mimetype    = mediaMsg.mimetype || (msgType === "imageMessage" ? "image/jpeg" : "video/mp4");
              const captionText = mediaMsg.caption || "";
              const ownerJid    = sessionCtx.ownerNumber[0] + "@s.whatsapp.net";
              if (ownerJid && ownerJid !== "@s.whatsapp.net") {
                await sock.sendMessage(ownerJid, {
                  [msgType === "imageMessage" ? "image" : "video"]: buffer,
                  mimetype,
                  caption: `📥 *Status Downloaded*\n👤 From: ${participant.split("@")[0]}\n\n${captionText}`,
                });
              }
            } catch (e) {
              console.log("Download/forward error:", e?.message);
            }
          }

          continue messageLoop;
        }

        // ── Parse message ────────────────────────────────────
        const m    = sms(sock, mek);
        let   body = String(getBodyFromMessage(mek.message) || "").trim();

        let isCmd       = body.startsWith(prefix);
        let commandName = isCmd
          ? body.slice(prefix.length).trim().split(" ")[0].toLowerCase()
          : "";
        let args = body.trim().split(/ +/).slice(1);
        let q    = args.join(" ");

        const from   = mek.key.remoteJid;
        const sender = mek.key.fromMe
          ? sock.user.id
          : mek.key.participant || mek.key.remoteJid;

        const rawSenderNumber = (sender || "").split("@")[0];
        const senderNumber    = rawSenderNumber.split(":")[0].replace(/\D/g, "");
        const isGroup         = from.endsWith("@g.us");
        const isOwner         = sessionCtx.ownerNumber.includes(senderNumber);

        // pushName: WhatsApp display name of the sender
        const pushName = mek.pushName || m?.pushName || senderNumber;

        const reply = (text) =>
          sock.sendMessage(from, { text }, { quoted: mek });

        // ── Presence update ──────────────────────────────────
        try {
          const presenceMode = readSettings().always_presence;
          if (presenceMode === "typing")    await sock.sendPresenceUpdate("composing",  from);
          else if (presenceMode === "recording") await sock.sendPresenceUpdate("recording", from);
        } catch (_) {}

        // ── Auto react plugin ────────────────────────────────
        try {
          if (autoReactPlugin && typeof autoReactPlugin.onMessage === "function") {
            await autoReactPlugin.onMessage(sock, mek, m, {
              from, body, args, q, sender, senderNumber,
              isGroup, isOwner, reply, isCmd, commandName, prefix,
            });
          }
        } catch (e) {
          console.log("AutoReact hook error:", e?.message || e);
        }

        // ── Private mode gate ────────────────────────────────
        const botSettings = readSettings();
        if (botSettings.mode === "private" && !isOwner) {
          if (isCmd) continue messageLoop;
        }

        // ── AUTO MSG PLUGIN (per-user Gemini key) ────────────
        //    Only runs on non-command messages in private chats.
        //    Commands like .setkey / .mykeys / .msg are handled
        //    inside the plugin via the normal cmd() system below.
        if (!isCmd && !isGroup) {
          try {
            const handled = await handleAutoMsg({
              conn:               sock,
              mek,
              m,
              sender,
              pushName,
              body,
              isGroup,
              sessionOwnerPhone:  sessionCtx.ownerNumber[0] || "",
              sessionOwnerName:   BOT_OWNER_NAME,
            });
            if (handled) continue messageLoop;
          } catch (e) {
            console.log("⚠️ handleAutoMsg error:", e?.message || e);
          }
        }

        // ── cmd_autofix_confirm plugin ───────────────────────
        try {
          if (cmdFixPlugin && typeof cmdFixPlugin.onMessage === "function") {
            const res = await cmdFixPlugin.onMessage(sock, mek, m, {
              from, body, args, q, sender, senderNumber,
              isGroup, isOwner, reply, prefix, isCmd, commandName, commands,
            });
            if (res?.handled && !res?.newBody) continue messageLoop;
            if (res?.handled && res?.newBody) {
              body        = String(res.newBody || "");
              isCmd       = body.startsWith(prefix);
              commandName = isCmd ? body.slice(prefix.length).trim().split(" ")[0].toLowerCase() : "";
              args        = body.trim().split(/ +/).slice(1);
              q           = args.join(" ");
            }
          }
        } catch (e) {
          console.log("cmdFixPlugin error:", e?.message || e);
        }

        // ── PDF scanner plugin ───────────────────────────────
        try {
          if (pdfScannerPlugin && typeof pdfScannerPlugin.onMessage === "function") {
            await pdfScannerPlugin.onMessage(sock, mek, m, {
              from, body, args, q, sender, senderNumber,
              isGroup, isOwner, reply, isCmd, commandName, prefix,
            });
          }
        } catch (e) {
          console.log("pdfScannerPlugin error:", e?.message || e);
        }

        // ── Reply handlers ───────────────────────────────────
        if (!isCmd && replyHandlers && replyHandlers.length) {
          for (const h of replyHandlers) {
            if (typeof h.filter !== "function") continue;
            let ok = false;
            try { ok = h.filter(body, { sender, from, isGroup, senderNumber }); } catch { ok = false; }
            if (ok) {
              if (h.react) sock.sendMessage(from, { react: { text: h.react, key: mek.key } });
              await h.function(sock, mek, m, {
                from, body, args, q, sender, senderNumber, isGroup, isOwner, reply,
              });
              break;
            }
          }
        }

        // ── Command handler ──────────────────────────────────
        if (isCmd) {
          if (botSettings.mode === "private" && !isOwner) continue messageLoop;

          const cmd = commands.find(
            (c) => c.pattern === commandName || c.alias?.includes(commandName)
          );

          if (cmd) {
            if (cmd.react) sock.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
            await cmd.function(sock, mek, m, {
              from, body, args, q, sender, senderNumber, isGroup, isOwner, reply,
            });
          }
        }
      } catch (e) {
        console.log("⚠️ Message process error:", e?.message || e);
      }
    }
  });

  // ── messages.update (poll votes, antidelete) ─────────────────
  sock.ev.on("messages.update", async (updates) => {
    if (global.pluginHooks) {
      for (const plugin of global.pluginHooks) {
        if (typeof plugin.onDelete === "function") {
          try { await plugin.onDelete(sock, updates); } catch (e) {
            console.log("AntiDelete onDelete error:", e?.message);
          }
        }
      }
    }

    for (const { key, update } of updates) {
      if (update.pollUpdates && key.fromMe === false) {
        try {
          const pollVote = update.pollUpdates[0].vote;
          const pollName = pollVote.selectedOptions[0];

          // Route poll vote through auto_msg if applicable
          if (pollName) {
            try {
              await handleAutoMsg({
                conn:              sock,
                mek:               { key, message: {} },
                m:                 {},
                sender:            key.participant || key.remoteJid,
                pushName:          "",
                body:              pollName,
                isGroup:           key.remoteJid.endsWith("@g.us"),
                sessionOwnerPhone: sessionCtx.ownerNumber[0] || "",
                sessionOwnerName:  BOT_OWNER_NAME,
              });
            } catch (_) {}
          }
        } catch (e) {
          console.log("Poll handling error:", e.message);
        }
      }
    }
  });
}

/* ==================== EXPRESS SERVER ==================== */
app.get("/", (req, res) => {
  res.send(
    `Hey There, MALIYA-MD started ✅ | Active Sessions: ${activeSessions.size}/${MAX_ACTIVE_SESSIONS}`
  );
});

app.get("/sessions", async (req, res) => {
  try {
    const docs = await getConnectableSessions(200);
    res.json({
      active:   activeSessions.size,
      max:      MAX_ACTIVE_SESSIONS,
      sessions: docs.map((d) => ({
        sessionId: d.sessionId,
        phone:     d.phone     || null,
        status:    d.status    || null,
        updatedAt: d.updatedAt || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

app.get("/health", (_req, res) => res.status(200).send("OK"));

app.listen(port, () => {
  console.log(`🚀 Server listening on http://localhost:${port}`);
  console.log(`🔥 Multi-user mode ready | Max active sessions: ${MAX_ACTIVE_SESSIONS}`);
});

/* ==================== START ==================== */
ensureConfiguredSession();
startSessionWatcher();
