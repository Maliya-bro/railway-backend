// models/User.js — Local + Google accounts
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { MongoClient } = require("mongodb");
import { getMongoUri } from "../security.js";

// We use raw MongoDB (no mongoose) to match the rest of the project.
// Collection: "users"
// Schema (soft):
//   _id           ObjectId
//   name          string
//   email         string  (unique, lowercase)
//   password      string | null  (bcrypt hash; null for Google-only accounts)
//   photo         string | null
//   provider      "local" | "google"
//   googleId      string | null
//   createdAt     Date

let _col = null;
async function col() {
  if (_col) return _col;
  const uri = getMongoUri();
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  _col = db.collection("users");
  // ensure unique index on email
  await _col.createIndex({ email: 1 }, { unique: true, sparse: true });
  return _col;
}

export async function findByEmail(email) {
  const c = await col();
  return c.findOne({ email: email.toLowerCase().trim() });
}

export async function findByGoogleId(googleId) {
  const c = await col();
  return c.findOne({ googleId });
}

export async function createLocal({ name, email, hashedPassword }) {
  const c = await col();
  const doc = {
    name,
    email:     email.toLowerCase().trim(),
    password:  hashedPassword,
    photo:     null,
    provider:  "local",
    googleId:  null,
    createdAt: new Date(),
  };
  const result = await c.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function upsertGoogle({ googleId, name, email, photo }) {
  const c   = await col();
  const low = email.toLowerCase().trim();

  // 1. Already linked with this googleId → update and return
  const byGid = await c.findOneAndUpdate(
    { googleId },
    { $set: { name, email: low, photo, provider: "google", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (byGid) return byGid;

  // 2. Existing local account with same email → link Google to it
  const byEmail = await c.findOneAndUpdate(
    { email: low },
    { $set: { googleId, photo, provider: "google", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (byEmail) return byEmail;

  // 3. Brand new user → insert
  const doc = {
    googleId,
    name,
    email:     low,
    password:  null,
    photo,
    provider:  "google",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await c.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}
