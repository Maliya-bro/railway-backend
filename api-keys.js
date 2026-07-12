// ═══════════════════════════════════════════════════════════════
//  api-keys.js — API Key management routes
//  GET  /api-keys/          — serve dashboard page
//  GET  /api-keys/list      — list user's keys (JSON)
//  POST /api-keys/create    — create a new key
//  DELETE /api-keys/:id     — revoke a key
// ═══════════════════════════════════════════════════════════════
import express from "express";
import path    from "path";
import { fileURLToPath } from "url";
import { createApiKey, listApiKeys, revokeApiKey } from "./models/ApiKey.js";

const router   = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireLogin(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ ok: false, error: "Login required." });
}

// Serve the dashboard HTML
router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "api-dashboard.html"));
});

// List keys
router.get("/list", requireLogin, async (req, res) => {
  try {
    const keys = await listApiKeys(req.user._id);
    // Mask key: show first 18 + *** + last 4
    const masked = keys.map(k => ({
      _id:        k._id,
      label:      k.label,
      keyPreview: k.key.slice(0, 18) + "***" + k.key.slice(-4),
      keyFull:    k.key,
      active:     k.active,
      usageCount: k.usageCount,
      lastUsedAt: k.lastUsedAt,
      createdAt:  k.createdAt,
    }));
    res.json({ ok: true, keys: masked });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create key
router.post("/create", requireLogin, async (req, res) => {
  try {
    const label = (req.body?.label || "My API Key").toString().slice(0, 40);
    const doc   = await createApiKey(req.user._id, label);
    res.json({ ok: true, key: doc.key, label: doc.label });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Revoke key
router.delete("/:id", requireLogin, async (req, res) => {
  try {
    const deleted = await revokeApiKey(req.params.id, req.user._id);
    if (!deleted) return res.status(404).json({ ok: false, error: "Key not found." });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
