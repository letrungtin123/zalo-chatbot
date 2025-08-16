// server.js
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import fs from "fs";

import { sendText } from "./zaloApi.js";
import { generateReply } from "./gemini.js";
import * as oauth from "./zaloOAuth.js";
import { loadCompanyInfo } from "./companyInfo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(bodyParser.json());

// Static (giữ nếu bạn còn file xác thực ở /public)
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

app.get("/health", (_req, res) => res.status(200).send("OK"));

// Nạp hồ sơ công ty 1 lần lúc boot
const COMPANY = loadCompanyInfo(__dirname);
console.log("COMPANY loaded:", {
  name: COMPANY.name || COMPANY.legal_name,
  have_faqs: (COMPANY.faqs || []).length,
});

// Chống gửi đôi
const seenMsgIds = new Set();

// Webhook (Zalo OA)
app.post("/webhook", async (req, res) => {
  try {
    const raw = req.body || {};
    const event = raw?.event_name;

    // Chỉ xử lý tin người dùng gửi vào
    if (event !== "user_send_text") return res.status(200).send("ignored");

    const text   = raw?.message?.text;
    const userId = raw?.sender?.id || raw?.sender?.user_id;
    const msgId  = raw?.message?.msg_id;

    if (msgId) {
      if (seenMsgIds.has(msgId)) return res.status(200).send("dup");
      seenMsgIds.add(msgId);
      setTimeout(() => seenMsgIds.delete(msgId), 60_000);
    }

    if (!userId || !text) return res.status(200).send("ignored");

    console.log("[WEBHOOK] incoming:", JSON.stringify({ userId, text, raw }));

    // Gọi LLM (đã tiêm hồ sơ công ty)
    let reply;
    try {
      reply = await generateReply([], text, COMPANY);
    } catch (e) {
      console.error("Gemini error:", e);
      reply = "Xin lỗi, mình đang bận. Bạn vui lòng thử lại sau nhé!";
    }

    // Gửi trả lời trong khung 24h (CS)
    const accessToken = await oauth.ensureAccessToken();
    const resp = await sendText(accessToken, userId, reply);
    console.log("[WEBHOOK] sendText resp:", resp);

    res.status(200).send("ok");
  } catch (err) {
    console.error("[WEBHOOK] error:", err);
    res.status(200).send("error");
  }
});

// Verify token (nếu Zalo gọi GET /webhook)
app.get("/webhook", (req, res) => {
  if (req.query?.verify_token === process.env.VERIFY_TOKEN) return res.send("verified");
  if (req.query?.challenge) return res.send(req.query.challenge);
  res.send("ok");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const gk = (process.env.GOOGLE_API_KEY || "").slice(0, 4);
  console.log(`Gemini key prefix: ${gk}`);
  console.log(`✅ Server listening on port ${port}`);
});
