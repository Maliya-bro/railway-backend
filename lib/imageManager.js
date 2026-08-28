// lib/imageManager.js
// Image management for bot plugins (per session, max 3MB)

const { MongoClient } = require("mongodb");

// Reuse same MongoDB connection as botSettings
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://maliya-md:279221@maliya-md.tzrnzrj.mongodb.net/?appName=MALIYA-MD";

const MONGODB_DB = process.env.MONGODB_DB || "maliya_md";
const IMAGES_COLLECTION = process.env.IMAGES_COLLECTION || "bot_images";

let cachedClient = null;
let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  cachedClient = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
  await cachedClient.connect();
  cachedDb = cachedClient.db(MONGODB_DB);
  console.log("✅ imageManager: Connected to MongoDB");
  return cachedDb;
}

// ── Get custom image for a session ──────────────────────────
// Returns: { data: "data:image/png;base64,...", mimeType, size } or null
async function getCustomImage(sessionId, key) {
  if (!sessionId || !key) return null;
  try {
    const db = await getDb();
    const col = db.collection(IMAGES_COLLECTION);
    const doc = await col.findOne({ sessionId, key });
    if (!doc) return null;
    return {
      data: doc.data,
      mimeType: doc.mimeType,
      size: doc.size,
      updatedAt: doc.updatedAt,
    };
  } catch (e) {
    console.log(`⚠️ getCustomImage error (${sessionId}, ${key}):`, e?.message || e);
    return null;
  }
}

// ── Set custom image for a session ──────────────────────────
// data: base64 data URL (e.g., "data:image/png;base64,...")
// maxSize: 3MB (3 * 1024 * 1024)
async function setCustomImage(sessionId, key, dataUrl) {
  if (!sessionId || !key || !dataUrl) {
    throw new Error("sessionId, key, and dataUrl are required");
  }

  // Validate data URL
  const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) {
    throw new Error("Invalid image data format. Must be a data URL.");
  }

  const mimeType = matches[1];
  const base64 = matches[2];
  const size = Buffer.byteLength(base64, "base64");

  // 3MB limit
  const MAX_SIZE = 3 * 1024 * 1024;
  if (size > MAX_SIZE) {
    throw new Error(`Image size (${(size / 1024 / 1024).toFixed(2)}MB) exceeds 3MB limit.`);
  }

  try {
    const db = await getDb();
    const col = db.collection(IMAGES_COLLECTION);
    await col.updateOne(
      { sessionId, key },
      {
        $set: {
          data: dataUrl,
          mimeType,
          size,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    return { ok: true, size };
  } catch (e) {
    console.log(`⚠️ setCustomImage error (${sessionId}, ${key}):`, e?.message || e);
    throw e;
  }
}

// ── Delete custom image ──────────────────────────────────────
async function deleteCustomImage(sessionId, key) {
  if (!sessionId || !key) return false;
  try {
    const db = await getDb();
    const col = db.collection(IMAGES_COLLECTION);
    const result = await col.deleteOne({ sessionId, key });
    return result.deletedCount > 0;
  } catch (e) {
    console.log(`⚠️ deleteCustomImage error (${sessionId}, ${key}):`, e?.message || e);
    return false;
  }
}

// ── List all custom images for a session ────────────────────
async function listCustomImages(sessionId) {
  if (!sessionId) return [];
  try {
    const db = await getDb();
    const col = db.collection(IMAGES_COLLECTION);
    const docs = await col.find({ sessionId }).toArray();
    return docs.map((doc) => ({
      key: doc.key,
      mimeType: doc.mimeType,
      size: doc.size,
      updatedAt: doc.updatedAt,
    }));
  } catch (e) {
    console.log(`⚠️ listCustomImages error (${sessionId}):`, e?.message || e);
    return [];
  }
}

module.exports = {
  getCustomImage,
  setCustomImage,
  deleteCustomImage,
  listCustomImages,
};
