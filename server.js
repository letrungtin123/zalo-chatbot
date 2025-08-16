// server.js
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { sendText } from "./zaloApi.js";
import { generateReply } from "./gemini.js";
import * as oauth from "./zaloOAuth.js"; // alias rõ ràng

// ----- Setup paths -----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- App -----
const app = express();
app.set("trust proxy", true);
app.use(bodyParser.json({ limit: "1mb" }));

// ----- Public (file verify html nếu cần) -----
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// Nếu dùng ENV để phục vụ file verify
const VERIFY_FILENAME = (process.env.ZALO_VERIFY_FILENAME || "").trim();
const VERIFY_CONTENT = (process.env.ZALO_VERIFY_CONTENT || "").trim();
if (VERIFY_FILENAME) {
  const verifyPath = "/" + VERIFY_FILENAME.replace(/^\//, "");
  app.get(verifyPath, (_req, res) => {
    if (VERIFY_CONTENT) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(VERIFY_CONTENT);
    }
    const onDisk = path.join(publicDir, VERIFY_FILENAME);
    if (fs.existsSync(onDisk)) return res.sendFile(onDisk);
    return res.status(404).send("Verifier file not found");
  });
}

// Health
app.get("/health", (_req, res) => res.status(200).send("OK"));

// Debug: nhìn nhanh key đã nạp chưa (log 6 ký tự đầu, đừng để lâu)
console.log(
  "GOOGLE_API_KEY loaded:",
  ((process.env.GOOGLE_API_KEY || "").trim().slice(0, 6) || "EMPTY") + "..."
);

// Debug: ping gemini
app.get("/debug/gemini", async (_req, res) => {
  try {
    const out = await generateReply([], 'nói chữ "pong"');
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, err: String(e) });
  }
});

// Webhook verify GET (optional)
app.get("/webhook", (req, res) => {
  const token = (process.env.VERIFY_TOKEN || "").trim();
  if (token && req.query?.verify_token === token) return res.send("verified");
  if (req.query?.challenge) return res.send(String(req.query.challenge));
  return res.send("ok");
});

// Webhook POST
app.post("/webhook", async (req, res) => {
  try {
    const raw = req.body || {};
    // Chuẩn hóa (Zalo push có dạng sender.id / message.text)
    const userId =
      raw?.sender?.user_id ||
      raw?.sender?.id ||
      raw?.user?.user_id ||
      raw?.recipient?.user_id ||
      null;

    const text =
      raw?.message?.text || raw?.message?.content?.text || raw?.text || null;

    console.log("[WEBHOOK] incoming:", JSON.stringify({ userId, text, raw }));

    if (!userId || !text) {
      console.log("[WEBHOOK] ignored: missing userId/text");
      return res.status(200).send("ignored");
    }

    // Gọi Gemini
    const history = []; // nếu cần bạn lưu lịch sử
    const reply = await generateReply(history, text || "");

    // Lấy access_token từ tokens.json (đã exchange trước đó)
    const accessToken = await oauth.ensureAccessToken();

    // Gửi trả lời cho user
    const sendResp = await sendText(accessToken, userId, reply);

    // Nếu OA chưa nâng gói
    if (sendResp?.error === -224) {
      console.warn(
        "[WEBHOOK] OA tier restriction (-224). Không thể gửi tin nhắn. Xem thêm giá: https://zalo.cloud/oa/pricing"
      );
    } else if (sendResp?.error) {
      console.warn("[WEBHOOK] sendText error:", sendResp);
    } else {
      console.log("[WEBHOOK] sendText ok:", sendResp);
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e);
    return res.status(500).send("error");
  }
});

// Start
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
