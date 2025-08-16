// server.js
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { sendText } from "./zaloApi.js";
import { generateReply } from "./gemini.js";
import * as oauth from "./zaloOAuth.js"; // dùng ensureAccessToken()

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", true);
app.use(bodyParser.json({ limit: "1mb" }));

/* -------------------- Load company profile -------------------- */
const COMPANY_PATH = path.join(__dirname, "companyInfo.json");
let COMPANY = {};
function loadCompany() {
  try {
    const raw = fs.readFileSync(COMPANY_PATH, "utf8");
    const json = JSON.parse(raw);
    COMPANY = json || {};
    console.log("COMPANY loaded:", {
      name: COMPANY.name || COMPANY.legal_name || "",
      have_faqs: Array.isArray(COMPANY.faqs) ? COMPANY.faqs.length : 0,
    });
  } catch (e) {
    console.error("⚠️ Cannot load companyInfo.json:", e.message);
    COMPANY = {};
  }
}
loadCompany();

/* -------------------- Static (nếu cần verify html) -------------------- */
app.use(express.static(path.join(__dirname, "public")));

/* -------------------- Health & Debug -------------------- */
app.get("/health", (_req, res) => res.send("OK"));

app.get("/debug/company", (_req, res) => res.json(COMPANY));

app.get("/debug/ask", async (req, res) => {
  const q = (req.query.text || "").toString();
  try {
    const ans = await generateReply([], q, COMPANY);
    res.type("text/plain").send(ans);
  } catch (e) {
    res.status(500).type("text/plain").send(String(e));
  }
});

// Reload hồ sơ công ty mà không cần deploy (bảo vệ bằng VERIFY_TOKEN)
app.post("/admin/reload", (req, res) => {
  try {
    if ((req.query.token || "") !== (process.env.VERIFY_TOKEN || "")) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    loadCompany();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* -------------------- Webhook verify (GET) -------------------- */
// Hỗ trợ kiểu verify token/challenge nếu Zalo gọi GET
app.get("/webhook", (req, res) => {
  if (req.query?.verify_token === process.env.VERIFY_TOKEN) return res.send("verified");
  if (req.query?.challenge) return res.send(req.query.challenge);
  res.send("ok");
});

/* -------------------- Webhook message (POST) -------------------- */
app.post("/webhook", async (req, res) => {
  try {
    const raw = req.body || {};
    const ev = raw.event_name;
    // Chỉ phản hồi cho sự kiện user gửi text
    if (ev !== "user_send_text") {
      console.log("[WEBHOOK] incoming(non-text):", JSON.stringify(raw));
      return res.status(200).send("ignored");
    }

    const userId = raw?.sender?.id || raw?.user?.user_id || null;
    const text = raw?.message?.text || raw?.text || null;

    console.log("[WEBHOOK] incoming:", JSON.stringify({ userId, text, raw }));

    if (!userId || !text) return res.status(200).send("ignored");

    // Tạo trả lời
    let answer = await generateReply([], text, COMPANY);

    // Gửi đi qua Zalo V3
    const accessToken = await oauth.ensureAccessToken();
    const resp = await sendText(accessToken, userId, answer);
    console.log("[WEBHOOK] sendText resp:", resp);

    return res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e);
    return res.status(500).send("error");
  }
});

/* -------------------- Start -------------------- */
const port = process.env.PORT || 3000;
console.log("ENV check: GOOGLE_API_KEY=", (process.env.GOOGLE_API_KEY || "").slice(0, 4), "ZALO_APP_ID=", process.env.ZALO_APP_ID);
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
