// server.js
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import fs from "fs/promises";

import { generateReply } from "./gemini.js";
import { sendCS } from "./zaloApi.js";
// CHÚ Ý: tên file trên Linux phải đúng TRÙNG KHỚP chữ hoa/thường
// Nếu file của bạn là zaloOAuth.js, import phải y chang:
import { ensureAccessToken } from "./zaloOAuth.js";

import { addSub, removeSub, loadSubs } from "./subscribersStore.js";

// ------------------ Setup cơ bản ------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();                        // <-- PHẢI tạo app TRƯỚC khi dùng app.get/app.post
app.set("trust proxy", true);
app.use(bodyParser.json({ limit: "1mb" }));

// Serve static & file verify (nếu có)
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

const VERIFY_FILENAME = process.env.ZALO_VERIFY_FILENAME || "";
const VERIFY_CONTENT  = process.env.ZALO_VERIFY_CONTENT || "";
if (VERIFY_FILENAME) {
  const verifyPath = "/" + VERIFY_FILENAME.replace(/^\//, "");
  app.get(verifyPath, async (_req, res) => {
    if (VERIFY_CONTENT) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(VERIFY_CONTENT);
    }
    try {
      const filePath = path.join(publicDir, VERIFY_FILENAME);
      const content = await fs.readFile(filePath);
      res.status(200).end(content);
    } catch {
      res.status(404).send("Verifier file not found.");
    }
  });
}

// Health check
app.get("/health", (_req, res) => res.status(200).send("OK"));

// ------------------ Webhook ------------------
app.post("/webhook", async (req, res) => {
  try {
    const raw = req.body || {};
    const ev  = raw?.event_name;
    const senderId    = raw?.sender?.id || raw?.sender?.user_id;
    const recipientId = raw?.recipient?.id || raw?.recipient?.user_id;

    // Theo dõi danh sách subscriber
    if (ev === "user_follow"   && senderId) await addSub(senderId);
    if (ev === "user_unfollow" && senderId) await removeSub(senderId);
    if (ev === "user_send_text" && senderId) await addSub(senderId);

    // Xử lý tin nhắn văn bản
    if (ev === "user_send_text") {
      const userId = senderId;
      const text   = raw?.message?.text || "";

      if (userId && text) {
        const accessToken = await ensureAccessToken();
        // Generate reply từ Gemini
        const reply = await generateReply([], text);
        const resp  = await sendCS(accessToken, userId, reply);
        console.log("[WEBHOOK] sendText resp:", resp);
      }
    }

    res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e);
    res.status(500).send("error");
  }
});

// ------------------ Broadcast theo lịch ------------------
async function broadcastAll(text) {
  const accessToken = await ensureAccessToken();
  const ids = await loadSubs();
  if (!ids.length) {
    console.log("[BROADCAST] List empty.");
    return { ok: 0, fail: 0, total: 0 };
  }

  console.log(`[BROADCAST] Sending to ${ids.length} users ...`);
  let ok = 0, fail = 0;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  for (const uid of ids) {
    try {
      const resp = await sendCS(accessToken, uid, text);
      if (resp?.error === 0) ok++;
      else fail++;
    } catch (err) {
      fail++;
      console.error("[BROADCAST] send error:", uid, err?.response?.data || err?.message);
    }
    await sleep(120); // tránh rate-limit
  }

  console.log("[BROADCAST] done:", { ok, fail, total: ids.length });
  return { ok, fail, total: ids.length };
}

const TZ = process.env.TZ || "Asia/Ho_Chi_Minh";
const BROADCAST_CRON  = process.env.BROADCAST_CRON || ""; // ví dụ "30 8 * * *"
const BROADCAST_TEXT  = process.env.BROADCAST_TEXT || "🔔 Thông báo từ OA! Chúc bạn một ngày tốt lành!";
const ADMIN_KEY       = process.env.ADMIN_KEY || "";

if (BROADCAST_CRON) {
  console.log("[CRON] schedule:", BROADCAST_CRON, "TZ:", TZ);
  cron.schedule(BROADCAST_CRON, async () => {
    try {
      await broadcastAll(BROADCAST_TEXT);
    } catch (e) {
      console.error("[CRON] broadcast error:", e);
    }
  }, { timezone: TZ });
}

// Admin bắn thử thủ công
app.post("/admin/broadcast", async (req, res) => {
  const key = req.query.key || req.body?.key;
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).send("forbidden");
  const text = req.body?.text || BROADCAST_TEXT;
  const out = await broadcastAll(text);
  res.json(out);
});

// ------------------ Start server ------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("✅ Server listening on port", port);
});
