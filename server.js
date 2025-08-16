// server.js
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { sendText } from "./zaloApi.js";
import { generateReply, _debug_callGeminiDirect, _debug_callGeminiQuery } from "./gemini.js";
import * as oauth from "./zaloOAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", true);
app.use(bodyParser.json({ limit: "1mb" }));

const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

const VERIFY_FILENAME = (process.env.ZALO_VERIFY_FILENAME || "").trim();
const VERIFY_CONTENT  = (process.env.ZALO_VERIFY_CONTENT || "").trim();
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

app.get("/health", (_req, res) => res.status(200).send("OK"));

// In prefix để xác nhận KEY nạp đúng
console.log(
  "ENV check: GOOGLE_API_KEY prefix=",
  ((process.env.GOOGLE_API_KEY || "").trim().slice(0, 6) || "EMPTY"),
  " | ZALO_APP_ID=",
  process.env.ZALO_APP_ID || "EMPTY"
);

// --- Debug endpoints cho Gemini ---
app.get("/debug/gemini/header", async (_req, res) => {
  try {
    const out = await _debug_callGeminiDirect('Nói đúng 1 từ: "pong".');
    res.json({ ok: true, mode: "header", out });
  } catch (e) {
    res.status(500).json({ ok: false, mode: "header", err: e?.response?.data || e.message || e });
  }
});

app.get("/debug/gemini/query", async (_req, res) => {
  try {
    const out = await _debug_callGeminiQuery('Nói đúng 1 từ: "pong".');
    res.json({ ok: true, mode: "query", out });
  } catch (e) {
    res.status(500).json({ ok: false, mode: "query", err: e?.response?.data || e.message || e });
  }
});

// Verify GET
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
    const userId =
      raw?.sender?.user_id ||
      raw?.sender?.id ||
      raw?.user?.user_id ||
      raw?.recipient?.user_id ||
      null;

    const text =
      raw?.message?.text ||
      raw?.message?.content?.text ||
      raw?.text ||
      null;

    console.log("[WEBHOOK] incoming:", JSON.stringify({ userId, text, raw }));
    if (!userId || !text) return res.status(200).send("ignored");

    const reply = await generateReply([], text || "");

    // Trong lúc OA chưa nâng gói, có thể tắt gửi để tránh spam lỗi:
    if (String(process.env.DISABLE_ZALO_SEND || "").toLowerCase() === "1") {
      console.log("[WEBHOOK] DRY-RUN (no send). reply=", reply.slice(0, 80));
      return res.status(200).send("ok");
    }

    const accessToken = await oauth.ensureAccessToken();
    const sendResp = await sendText(accessToken, userId, reply);

    if (sendResp?.error === -224) {
      console.warn("[WEBHOOK] OA tier restriction (-224): https://zalo.cloud/oa/pricing");
    } else if (sendResp?.error) {
      console.warn("[WEBHOOK] sendText error:", sendResp);
    } else {
      console.log("[WEBHOOK] sendText ok:", sendResp);
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e?.response?.data || e.message || e);
    return res.status(500).send("error");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
