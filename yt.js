// ═══════════════════════════════════════════════════════════════
//  yt.js — YouTube Downloader API
//  POST /yt/search   — search YouTube, return top 3 results
//  POST /yt/info     — get video info by URL
//  POST /yt/download — get download link (sadaslk-dlcore)
// ═══════════════════════════════════════════════════════════════

import express       from "express";
import axios         from "axios";
import ytsr          from "ytsr";
import dlcore        from "sadaslk-dlcore";

const { ytmp3, ytmp4 } = dlcore;
const router = express.Router();

const YT_REGEX = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

function extractVideoId(url) {
  const m = url.match(YT_REGEX);
  return m ? m[1] : null;
}

// ── POST /yt/search ───────────────────────────────────────────
router.post("/search", async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim())
      return res.status(400).json({ ok: false, error: "Search query required." });

    const results = await ytsr(query.trim(), { limit: 10 });

    const videos = results.items
      .filter(i => i.type === "video" && i.id && !i.isLive)
      .slice(0, 3)
      .map(v => ({
        id:        v.id,
        title:     v.title        || "Unknown",
        author:    v.author?.name || "Unknown",
        thumbnail: `https://img.youtube.com/vi/${v.id}/hqdefault.jpg`,
        duration:  v.duration     || "",
        watchUrl:  `https://www.youtube.com/watch?v=${v.id}`,
      }));

    if (!videos.length)
      return res.json({ ok: false, error: "No results found. Try a different search term." });

    return res.json({ ok: true, videos });
  } catch (e) {
    console.error("[yt/search]", e?.message);
    return res.status(500).json({ ok: false, error: "Search failed. Try again." });
  }
});

// ── POST /yt/info ─────────────────────────────────────────────
router.post("/info", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string")
      return res.status(400).json({ ok: false, error: "YouTube URL required." });

    const id = extractVideoId(url.trim());
    if (!id)
      return res.status(400).json({ ok: false, error: "Invalid YouTube URL." });

    const oembed = await axios.get(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`,
      { timeout: 10000 }
    );

    return res.json({
      ok:        true,
      id,
      title:     oembed.data.title       || "Unknown Title",
      author:    oembed.data.author_name || "Unknown",
      thumbnail: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
      watchUrl:  `https://www.youtube.com/watch?v=${id}`,
    });
  } catch (e) {
    console.error("[yt/info]", e?.message);
    return res.status(500).json({ ok: false, error: "Could not fetch video info. Check the URL." });
  }
});

// ── POST /yt/download ─────────────────────────────────────────
// mode: "mp3" | "mp4"
router.post("/download", async (req, res) => {
  try {
    const { url, mode } = req.body || {};
    if (!url || typeof url !== "string")
      return res.status(400).json({ ok: false, error: "YouTube URL required." });

    const id = extractVideoId(url.trim());
    if (!id)
      return res.status(400).json({ ok: false, error: "Invalid YouTube URL." });

    const watchUrl = `https://www.youtube.com/watch?v=${id}`;

    let result;
    if (mode === "mp4") {
      result = await ytmp4(watchUrl, { format: "mp4", videoQuality: "720" });
    } else {
      result = await ytmp3(watchUrl);
    }

    if (!result || !result.url)
      return res.status(502).json({ ok: false, error: "Download link not available. Try again." });

    return res.json({
      ok:       true,
      url:      result.url,
      filename: result.filename || (mode === "mp4" ? "video.mp4" : "audio.mp3"),
    });
  } catch (e) {
    console.error("[yt/download]", e?.message);
    return res.status(500).json({ ok: false, error: "Download failed. Try again later." });
  }
});

export default router;
