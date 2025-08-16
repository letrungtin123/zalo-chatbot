// server.js
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { sendText } from "./zaloApi.js";
import { generateReply } from "./gemini.js";

// ----------------- Setup cơ bản -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", true); // Render/Proxy phía trước
app.use(bodyParser.json({ limit: "1mb" }));

// ----------------- Static & Verify file -----------------
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir)); // GET https://host/<file>
app.use("/verify", express.static(publicDir)); // tuỳ chọn: GET /verify/<file>

const VERIFY_FILENAME = process.env.ZALO_VERIFY_FILENAME || "";
const VERIFY_CONTENT = process.env.ZALO_VERIFY_CONTENT || "";
if (VERIFY_FILENAME) {
  const verifyPath = "/" + VERIFY_FILENAME.replace(/^\//, "");
  app.get(verifyPath, (req, res) => {
    // Nếu có ZALO_VERIFY_CONTENT, trả đúng chuỗi plain text
    if (VERIFY_CONTENT) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(VERIFY_CONTENT);
    }
    // Không có content → cố gắng serve file trong /public
    const fileOnDisk = path.join(publicDir, VERIFY_FILENAME);
    if (fs.existsSync(fileOnDisk)) return res.sendFile(fileOnDisk);
    return res.status(404).send("Verifier file not found on server.");
  });
}

// ----------------- Health & Root (cho Render) -----------------
app.get("/", (_req, res) => res.status(200).send("OK root"));
app.get("/health", (_req, res) => res.status(200).send("OK"));

// ----------------- Webhook verify (GET) -----------------
app.get("/webhook", (req, res) => {
  // Hai kiểu verify phổ biến
  if (req.query?.verify_token === process.env.VERIFY_TOKEN)
    return res.send("verified");
  if (req.query?.challenge) return res.send(req.query.challenge);
  res.send("ok");
});

// ----------------- Webhook nhận tin (POST) -----------------
app.post("/webhook", (req, res) => {
  // Ack NGAY để Zalo không timeout
  res.status(200).send("ok");

  // Xử lý reply ở background
  (async () => {
    try {
      const event = req.body || {};
      // Một số payload: { sender.user_id, message.text } hoặc { user.user_id, message.content.text }
      const userId =
        event?.sender?.user_id ||
        event?.user?.user_id ||
        event?.recipient?.user_id ||
        null;

      const text =
        event?.message?.text ||
        event?.message?.content?.text ||
        event?.text ||
        null;

      console.log(
        "[WEBHOOK] incoming:",
        JSON.stringify({ userId, text, raw: event }, null, 0)
      );

      if (!userId || !text) {
        console.log("[WEBHOOK] ignored (missing userId/text)");
        return;
      }

      // Tạo câu trả lời (Gemini)
      const history = []; // có thể lưu lịch sử nếu cần
      const reply = await generateReply(history, text);

      // Lấy access_token (đã hỗ trợ v4: header secret_key, form-urlencoded)
      const accessToken = await ensureAccessToken();

      // Gửi reply về Zalo
      const sendResp = await sendText(accessToken, userId, reply);
      console.log("[WEBHOOK] sendText resp:", sendResp);
    } catch (e) {
      console.error("[WEBHOOK] error:", e?.response?.data || e.message || e);
    }
  })();
});

// ----------------- OAuth callback (nếu dùng đổi code thủ công) -----------------
app.get("/oauth/callback", (req, res) => {
  const code = req.query.code || "";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<h3>OAuth callback</h3><p>Code: ${code}</p>`);
});

// ----------------- 404 fallback (tuỳ chọn) -----------------
app.use((req, res) => res.status(404).send("Not Found"));

// ----------------- Start server -----------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
