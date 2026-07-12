import fs from "fs";
import path from "path";
import dns from "dns";
import { MongoClient } from "mongodb";
import { getMongoUri, getMongoDb, getSessionCollection } from "./security.js";

// 🔥 fix DNS issues (Heroku important)
dns.setDefaultResultOrder("ipv4first");

// Read from security.js accessor — process.env vars are deleted at startup
const MONGODB_URI        = getMongoUri();
const MONGODB_DB         = getMongoDb();
const SESSION_COLLECTION = getSessionCollection();

let cachedClient = null;
let cachedDb = null;

/* ================= DB CONNECT ================= */

async function getDb() {
  if (cachedDb) return cachedDb;

  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is missing");
  }

  cachedClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    family: 4,
    serverSelectionTimeoutMS: 15000,
  });

  await cachedClient.connect();
  cachedDb = cachedClient.db(MONGODB_DB);
  console.log("✅ Connected to MongoDB");
  return cachedDb;
}

/* ================= HELPERS ================= */

function fileToBase64(filePath) {
  return fs.readFileSync(filePath).toString("base64");
}

// 🔥 IMPORTANT FIX → NO MODIFY SESSION ID
function normalizeSessionId(value) {
  return String(value || "").trim();
}

/* ================= UPLOAD ================= */

export async function upload(filePath, fileName, options = {}) {
  const db = await getDb();
  const col = db.collection(SESSION_COLLECTION);

  const sessionId = normalizeSessionId(
    options.sessionId ||
      path.parse(fileName || "session").name ||
      `session_${Date.now()}`,
  );

  const now = new Date();

  const uploadDoc = {
    sessionId,
    fileName: fileName || path.basename(filePath),
    primaryFile: {
      name: fileName || path.basename(filePath),
      mimeType: "application/json",
      data: fileToBase64(filePath),
    },
    status: options.status || "ready",
    connectBot: options.connectBot ?? true,
    source: options.source || "pair-site",
    phone: options.phone || null,
    updatedAt: now,
  };

  await col.updateOne(
    { sessionId },
    {
      $set: uploadDoc,
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  console.log("💾 Session saved:", sessionId);

  return sessionId;
}

/* ================= SAVE SESSION ================= */

export async function saveSessionState(options = {}) {
  const {
    sessionId,
    phone,
    filePath,
    fileName,
    source = "pair-site",
  } = options;

  if (!filePath) {
    throw new Error("filePath is required");
  }

  return upload(filePath, fileName || path.basename(filePath), {
    sessionId,
    phone,
    source,
    status: "ready",
    connectBot: true,
  });
}

/* ================= GET SESSION ================= */

export async function getSessionById(sessionId) {
  const db = await getDb();
  const col = db.collection(SESSION_COLLECTION);

  return col.findOne({ sessionId: normalizeSessionId(sessionId) });
}

/* ================= RESTORE CREDS ================= */

export async function restoreCredsToFile(sessionId, targetFilePath) {
  const doc = await getSessionById(sessionId);

  if (!doc) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (!doc.primaryFile?.data) {
    throw new Error(`No primaryFile found for session: ${sessionId}`);
  }

  fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
  fs.writeFileSync(targetFilePath, Buffer.from(doc.primaryFile.data, "base64"));

  console.log("📂 Restored creds:", sessionId);

  return targetFilePath;
}

/* ================= KEEP-ALIVE / WARMUP ================= */

// Call once at server startup to open the connection eagerly.
export async function warmupDb() {
  try {
    await getDb();
    console.log("🔗 MongoDB connection pre-warmed");
  } catch (e) {
    console.warn("⚠️ MongoDB pre-warm failed (will retry on first use):", e.message);
  }
}

// Ping the DB every N ms to keep the connection and Replit networking alive.
export async function keepAlivePing() {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
  } catch (e) {
    // Reset cached handles so the next real request reconnects cleanly.
    cachedClient = null;
    cachedDb = null;
    console.warn("⚠️ MongoDB keepalive ping failed — will reconnect on next use:", e.message);
  }
}

/* ================= CLOSE ================= */

export async function closeMongoConnection() {
  try {
    if (cachedClient) {
      await cachedClient.close();
    }
  } catch (err) {
    console.error("Error closing MongoDB connection:", err);
  } finally {
    cachedClient = null;
    cachedDb = null;
  }
}
