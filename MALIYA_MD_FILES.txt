========== FILE: index.js ==========
// ╔══════════════════════════════════════════════════════════════╗
//  MALIYA-MD — Multi-User WhatsApp Bot  (index.js)
//  Integrated: auto_msg plugin with per-user Gemini key support
//  FIX: handleAutoMsg now handles BOTH private + group messages
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
  "mongodb+srv://MALIYA-MD:279221279221@maliya-md.uzal3aa.mongodb.net/?appName=maliya-md";

console.log("🔗 MongoDB URI in use:", MONGODB_URI.replace(/:([^@]+)@/, ":****@"));

const MONGODB_DB         = process.env.MONGODB_DB         || "maliya_md";
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
  if (!doc)                   throw new Error(`Session not found in MongoDB: ${sessionId}`);
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
      if (plugin === "auto_msg.js")   return;
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
  const safeId    = safeSessionFolderName(sessionId);
  const authDir   = path.join(sessionsBaseDir, safeId);
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
  if (!sessionId)                     return;
  if (reconnectTimers.has(sessionId)) return;

  const timer = setTimeout(async () => {
    reconnectTimers.delete(sessionId);
    if (activeSessions.has(sessionId)) return;
    console.log(`🔁 Reconnecting session ${sessionId}...`);
    await startSessionBot(sessionId);
  }, delayMs);

  reconnectTimers.set(sessionId, timer);
}

async function startSessionBot(sessionId) {
  sessionId = normalizeSessionId(sessionId);
  if (!sessionId) return null;

  if (activeSessions.has(sessionId)) return activeSessions.get(sessionId);

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
      logger:                         P({ level: "silent" }),
      printQRInTerminal:              false,
      browser:                        Browsers.macOS("Firefox"),
      auth:                           state,
      version,
      syncFullHistory:                true,
      markOnlineOnConnect:            true,
      generateHighQualityLinkPreview: true,
    });

    sessionCtx.sock = sock;
    activeSessions.set(sessionId, sessionCtx);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          sessionCtx.connected   = true;
          sessionCtx.connecting  = false;
          sessionCtx.ownerNumber = getOwnerNumberForSock(sock);

          await updateSessionStatus(sessionId, {
            status:     "connected",
            connectBot: true,
            botJid:     sock.user?.id || null,
          });

          console.log(`✅ Session connected: ${sessionId}`);

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
        if (!id)                    continue;
        if (activeSessions.has(id)) continue;
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

  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!messages || !messages.length) return;

    messageLoop: for (const mek of messages) {
      try {
        if (!mek?.message) continue messageLoop;

        mek.message =
          getContentType(mek.message) === "ephemeralMessage"
            ? mek.message.ephemeralMessage.message
            : mek.message;

        if (global.pluginHooks) {
          for (const plugin of global.pluginHooks) {
            if (plugin.onMessage) {
              try { await plugin.onMessage(sock, mek); } catch (_) {}
            }
          }
        }

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

          if (readSettings().auto_status_seen === true) {
            try {
              await sock.readMessages([mek.key]);
              console.log(`[✓] Status seen: ${id} (${participant})`);
            } catch (e) {
              console.error("❌ Seen error:", e?.message || e);
            }
          }

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

          if (
            readSettings().auto_download_status === true &&
            (mek.message?.imageMessage || mek.message?.videoMessage)
          ) {
            try {
              const msgType  = mek.message.imageMessage ? "imageMessage" : "videoMessage";
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

        const pushName = mek.pushName || m?.pushName || senderNumber;

        const reply = (text) =>
          sock.sendMessage(from, { text }, { quoted: mek });

        try {
          const presenceMode = readSettings().always_presence;
          if (presenceMode === "typing")         await sock.sendPresenceUpdate("composing",  from);
          else if (presenceMode === "recording") await sock.sendPresenceUpdate("recording",  from);
        } catch (_) {}

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

        const botSettings = readSettings();
        if (botSettings.mode === "private" && !isOwner) {
          if (isCmd) continue messageLoop;
        }

        // ── AUTO MSG PLUGIN ───────────────────────────────────
        //    ✅ FIX: removed !isGroup condition
        //    handleAutoMsg() handles group/private logic internally
        //    based on global mode (.msg on all sets includeGroups)
        if (!isCmd) {
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


========== FILE: auto_msg.js (plugins/) ==========
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

// ─── Global Mode (bot owner controls ALL users) ───────────────
// global_cfg collection: { _id: "global", enabled: bool, includeGroups: bool }
async function setGlobalMode(enabled, includeGroups = false) {
  const db = await getDb();
  await db.collection("global_cfg").updateOne(
    { _id: "global" },
    { $set: { enabled: !!enabled, includeGroups: !!includeGroups, updatedAt: new Date() } },
    { upsert: true }
  );
}
async function getGlobalMode() {
  const db  = await getDb();
  const doc = await db.collection("global_cfg").findOne({ _id: "global" });
  return doc ? { enabled: doc.enabled, includeGroups: doc.includeGroups } : { enabled: false, includeGroups: false };
}

// ─── Per-user Auto-reply toggle ───────────────────────────────
async function setAutoReply(phone, enabled) {
  const db = await getDb();
  await db.collection("auto_msg_cfg").updateOne(
    { phone },
    { $set: { enabled: !!enabled, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
}
async function isAutoReplyEnabled(phone) {
  const db  = await getDb();
  const doc = await db.collection("auto_msg_cfg").findOne({ phone });
  return doc ? doc.enabled : false;
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
const SI_UNICODE  = /[\u0D80-\u0DFF]/;
const TA_UNICODE  = /[\u0B80-\u0BFF]/;
const SINGLISH_KW = [
  "mata","oya","mage","mokak","mokada","kohomada","karanna","puluwan",
  "thiyenawa","wenawa","kiyanne","kiyala","ane","machan","bro","ganna",
  "danna","hadanne","thiyanawa","wela","neda","api","eka","epa","wenna",
  "balanna","thawa","honda","tikak","godak","oyata","meka",
];
function detectLang(text) {
  if (SI_UNICODE.test(text))  return "si";
  if (TA_UNICODE.test(text))  return "ta";
  const lower = text.toLowerCase();
  if (SINGLISH_KW.some((w) => lower.includes(w))) return "si";
  return "en";
}

// ─── System Prompt ────────────────────────────────────────────
function buildSystemPrompt(ownerName, pushName, lang) {
  const who  = ownerName ? `${ownerName}ගේ MALIYA-MD WhatsApp Bot` : "MALIYA-MD WhatsApp Bot";
  const user = pushName && pushName.trim() ? pushName.trim() : "user";
  if (lang === "si") {
    return (
      `ඔයා ${who}. ඔයාව manage කරන්නේ ${ownerName || "Bot Owner"}.` +
      ` දැන් chat කරන කෙනාගේ නම ${user}. ඔවුන් ව ${user} කියලා address කරන්න.` +
      ` සෑම reply එකක්ම *සම්පූර්ණ සිංහල Unicode* ගෙන් ලියන්න.` +
      ` Singlish use කරන්නෙ නෑ. Short, friendly, natural.`
    );
  }
  if (lang === "ta") {
    return (
      `நீங்கள் ${who}. இப்போது பேசுபவரின் பெயர் ${user}. அவர்களை ${user} என்று அழையுங்கள்.` +
      ` தமிழில் பதில் சொல்லுங்கள். குறுகியதாக, நட்பாக பேசுங்கள்.`
    );
  }
  return (
    `You are ${who}. The person chatting is named ${user}. Address them as ${user} naturally.` +
    ` Reply in English. Be short, friendly, and natural.`
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

// Smart caller: Gemini → ch.at → pollinations
async function askAI(phone, systemPrompt, history, userText) {
  const keys = await getUserKeys(phone);
  if (keys.length) {
    for (const key of keys) {
      const result = await callGemini(key, systemPrompt, history, userText);
      if (result) return result;
    }
  }
  const freePrompt = systemPrompt ? `${systemPrompt}\n\nUser: ${userText}` : userText;
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
  if (lang === "si") return "❌ AI service unavailable. ටිකක් wait කරලා try කරන්න.\n> MALIYA-MD ❤️";
  if (lang === "ta") return "❌ AI சேவை இல்லை. சிறிது நேரம் கழித்து முயற்சிக்கவும்.\n> MALIYA-MD ❤️";
  return "❌ AI unavailable right now. Try again later.\n> MALIYA-MD ❤️";
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

// .msg on | on all | off | global off | status | clear | help
cmd({
  pattern: "msg",
  desc:    "Control AI auto-reply",
  type:    "all",
  react:   "🤖",
}, async (conn, mek, m, { args, sender }) => {
  const phone = sender.split("@")[0].replace(/\D/g, "");
  const sub   = (args[0] || "").toLowerCase().trim();
  const sub2  = (args[1] || "").toLowerCase().trim();
  const lang  = detectLang(m.body || "");

  // ── .msg on → per-user private AI on ─────────────────────
  if (sub === "on" && sub2 !== "all") {
    await setAutoReply(phone, true);
    const keys   = await getUserKeys(phone);
    const source = keys.length ? "🚀 Gemini AI" : "⚡ Free AI (ch.at + pollinations)";
    return m.reply(
      `✅ *AI auto reply ON* 📱\n` +
      `🧠 ${source}\n\n` +
      `> oma eka wena eken ena msg walata AI reply labheyi\n` +
      `> MALIYA-MD ❤️`
    );
  }

  // ── .msg on all → GLOBAL mode (private + groups) ─────────
  if (sub === "on" && sub2 === "all") {
    await setGlobalMode(true, true);
    return m.reply(
      `✅ *Global AI ON* 🌐\n\n` +
      `📱 Private chats — ✅\n` +
      `👥 Groups        — ✅\n\n` +
      `> Okkotama AI reply labheyi!\n` +
      `> Off karanna: *.msg global off*\n` +
      `> MALIYA-MD ❤️`
    );
  }

  // ── .msg off → turn off per-user (keeps global unchanged) ─
  if (sub === "off") {
    await setAutoReply(phone, false);
    return m.reply("⛔ *AI auto reply OFF* (oma eka)\n> MALIYA-MD ❤️");
  }

  // ── .msg global off → turn off global mode ────────────────
  if (sub === "global" && sub2 === "off") {
    await setGlobalMode(false, false);
    return m.reply(
      `⛔ *Global AI OFF*\n\n` +
      `> Group + okkoma global reply binda\n` +
      `> Per-user .msg on still works\n` +
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
    const global  = await getGlobalMode();
    const keys    = await getUserKeys(phone);
    const userOn  = await isAutoReplyEnabled(phone);
    const history = await getHistory(phone);
    const source  = keys.length ? `🚀 Gemini (${keys.length} key/s)` : "⚡ Free AI (ch.at + pollinations)";
    return m.reply(
      `📊 *AI Status*\n\n` +
      `🌐 Global Mode : ${global.enabled ? "ON ✅" : "OFF ⛔"}\n` +
      `👥 Groups      : ${global.includeGroups ? "ON ✅" : "OFF ⛔"}\n` +
      `🤖 My Reply    : ${userOn ? "ON ✅" : "OFF ⛔"}\n` +
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

    // ── Check global mode ────────────────────────────────────
    const global = await getGlobalMode();

    // Owner's own messages — never auto-reply to owner
    const senderIsOwner = isOwner(phone, sessionOwnerPhone);
    if (senderIsOwner) return false;

    // Determine if we should reply
    let shouldReply = false;

    if (global.enabled) {
      // Global ON → reply to all private chats
      // If includeGroups also ON → reply to groups too
      if (isGroup && global.includeGroups) shouldReply = true;
      if (!isGroup) shouldReply = true;
    } else {
      // Global OFF → check per-user setting (private only)
      if (isGroup) return false;
      shouldReply = await isAutoReplyEnabled(phone);
    }

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
