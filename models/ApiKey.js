// models/ApiKey.js — API key management
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { MongoClient, ObjectId } = require("mongodb");
import { getMongoUri } from "../security.js";
import crypto from "crypto";

let _col = null;
async function col() {
  if (_col) return _col;
  const client = new MongoClient(getMongoUri());
  await client.connect();
  const db = client.db();
  _col = db.collection("api_keys");
  await _col.createIndex({ key: 1 },    { unique: true });
  await _col.createIndex({ userId: 1 });
  return _col;
}

export function generateKey() {
  return "MALIYA-MD-" + crypto.randomBytes(20).toString("hex").toUpperCase();
}

// Create a new API key for a user (max 5 per user)
export async function createApiKey(userId, label = "My API Key") {
  const c = await col();
  const count = await c.countDocuments({ userId: userId.toString(), active: true });
  if (count >= 5) throw new Error("Maximum 5 API keys per account.");

  const key = generateKey();
  const doc = {
    key,
    userId:    userId.toString(),
    label,
    active:    true,
    usageCount: 0,
    lastUsedAt: null,
    createdAt:  new Date(),
  };
  await c.insertOne(doc);
  return doc;
}

// List all active keys for a user
export async function listApiKeys(userId) {
  const c = await col();
  return c.find({ userId: userId.toString() }).sort({ createdAt: -1 }).toArray();
}

// Revoke (delete) a key — only if it belongs to the user
export async function revokeApiKey(keyId, userId) {
  const c = await col();
  const result = await c.deleteOne({
    _id:    new ObjectId(keyId),
    userId: userId.toString(),
  });
  return result.deletedCount > 0;
}

// Validate an API key (used by external endpoints)
// Returns the key document or null
export async function validateApiKey(key) {
  if (!key || !key.startsWith("MALIYA-MD-")) return null;
  const c = await col();
  const doc = await c.findOne({ key, active: true });
  if (!doc) return null;
  // Update usage stats (fire and forget)
  c.updateOne({ _id: doc._id }, {
    $inc: { usageCount: 1 },
    $set: { lastUsedAt: new Date() },
  }).catch(() => {});
  return doc;
}
