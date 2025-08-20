// server.js
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import cron from "node-cron";

import { sendText } from "./zaloApi.js";      // V3 /oa/message/cs (header access_token)
import { generateReply } from "./gemini.js";  // đã xử lý companyInfo + KB + fallback
import { ensureAccessToken } from "./zaloOAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// ============== Static + Verifier (optional) ==============
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.use("/verify", express.static(publicDir));
}

const VERIFY_FILENAME = process.env.ZALO_VERIFY_FILENAME || "";
const VERIFY_CONTENT  = process.env.ZALO_VERIFY_CONTENT  || "";
if (VERIFY_FILENAME) {
  const verifyPath = "/" + VERIFY_FILENAME.replace(/^\//, "");
  app.get(verifyPath, (req, res) => {
    if (VERIFY_CONTENT) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(VERIFY_CONTENT);
    }
    const onDisk = path.join(publicDir, VERIFY_FILENAME);
    if (fs.existsSync(onDisk)) return res.sendFile(onDisk);
    return res.status(404).send("Verifier file not found on server.");
  });
}

// ============== Company Info (from file) ==============
let companyInfo = null;
const companyInfoPath = path.join(__dirname, "companyInfo.json");
try {
  if (fs.existsSync(companyInfoPath)) {
    companyInfo = JSON.parse(fs.readFileSync(companyInfoPath, "utf8"));
    console.log("Loaded companyInfo.json");
  } else {
    console.warn("⚠️ companyInfo.json not found (bot vẫn chạy, nhưng thiếu FAQ cục bộ).");
  }
} catch (e) {
  console.warn("⚠️ Cannot load companyInfo.json:", e.message);
}

// ============== Knowledge Base (external API) ==============
// Env chuẩn bạn yêu cầu:
const INTRO_API_BASE = process.env.INTRO_API_BASE || "https://asianasa.com:8443";
const INTRO_API_PATH = process.env.INTRO_API_PATH || "/api/Introduce/list";

// Lưu KB trong RAM
let KB_DOCS = []; // [{id, title, contentHtml, contentText}]
function stripHtml(html = "") {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p[\s\S]*?>/gi, "")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
async function refreshKB() {
  try {
    const full = `${INTRO_API_BASE.replace(/\/$/, "")}${INTRO_API_PATH.startsWith("/") ? INTRO_API_PATH : "/"+INTRO_API_PATH}`;
    console.log("[KB] fetching:", full);
    const r = await fetch(full, { method: "GET" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const items = Array.isArray(j?.data) ? j.data : [];
    KB_DOCS = items.map(it => {
      const title = (it.title || "").trim();
      const contentHtml = it.content || "";
      const contentText = stripHtml(contentHtml);
      return { id: it.id, title, contentHtml, contentText };
    });
    console.log("[KB] refreshed. docs=" + KB_DOCS.length);
  } catch (e) {
    console.log("[KB] refresh error:", e.message);
  }
}
// Nạp lần đầu + auto refresh 10 phút/lần
await refreshKB().catch(()=>{});
setInterval(refreshKB, 10 * 60 * 1000);

// ============== Subscribers store (Upstash Redis or file) ==============
const SUBS_FILE = path.join(__dirname, "subscribers.json");
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REST_URL || "";
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REST_TOKEN || "";
const SUBS_KEY = process.env.SUBSCRIBERS_KEY || "zalo:subscribers";

async function addSubscriber(userId) {
  if (!userId) return;
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const url = `${UPSTASH_URL}/sadd/${encodeURIComponent(SUBS_KEY)}/${encodeURIComponent(String(userId))}`;
      await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }});
      return;
    } catch (e) {
      console.error("[SUBS] upstash sadd error:", e.message);
    }
  }
  try {
    let arr = [];
    if (fs.existsSync(SUBS_FILE)) {
      arr = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
      if (!Array.isArray(arr)) arr = [];
    }
    const s = String(userId);
    if (!arr.includes(s)) {
      arr.push(s);
      fs.writeFileSync(SUBS_FILE, JSON.stringify(arr, null, 2), "utf8");
    }
  } catch (e) {
    console.error("[SUBS] file write error:", e.message);
  }
}
async function loadSubscribers() {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const url = `${UPSTASH_URL}/smembers/${encodeURIComponent(SUBS_KEY)}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }});
      const j = await r.json();
      const ids = Array.isArray(j.result) ? j.result : [];
      return ids.map(String);
    } catch (e) {
      console.error("[SUBS] upstash smembers error:", e.message);
    }
  }
  try {
    if (!fs.existsSync(SUBS_FILE)) return [];
    const raw = fs.readFileSync(SUBS_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

// ============== Helpers ==============
function extractIncoming(evt) {
  const userId =
    evt?.sender?.id ||
    evt?.sender?.user_id ||
    evt?.user?.user_id ||
    null;

  const text =
    evt?.message?.text ||
    evt?.message?.content?.text ||
    evt?.text ||
    null;

  return { userId, text, eventName: evt?.event_name };
}

async function safeSendText(userId, text) {
  let token = await ensureAccessToken();
  let resp  = await sendText(token, userId, text);
  if (resp?.error === -216 && /expired/i.test(resp?.message || "")) {
    token = await ensureAccessToken({ force: true });
    resp  = await sendText(token, userId, text);
  }
  return resp;
}

// ============== Health & Verify ==============
app.get("/health", (_req, res) => res.status(200).send("OK"));
app.get("/webhook", (req, res) => {
  if (req.query?.verify_token === process.env.VERIFY_TOKEN) return res.send("verified");
  if (req.query?.challenge) return res.send(req.query.challenge);
  res.send("ok");
});
app.get("/oauth/callback", (req, res) => {
  const code = req.query.code || "";
  res.send(`<h3>OAuth callback</h3><p>Code: ${code}</p>`);
});

// ============== Zalo Webhook (V3) ==============
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body || {};
    const { userId, text, eventName } = extractIncoming(event);
    console.log("[WEBHOOK] incoming:", JSON.stringify({ event_name: eventName, userId, text }).slice(0, 1000));

    if (userId && (eventName === "user_follow" || eventName === "user_send_text")) {
      await addSubscriber(userId);
    }
    if (eventName !== "user_send_text") return res.status(200).send("ok");
    if (!userId || !text)              return res.status(200).send("ignored");

    const history = []; // chỗ này bạn có thể lưu hội thoại nếu muốn
    const reply   = await generateReply(history, text, companyInfo, KB_DOCS);

    const resp = await safeSendText(userId, reply);
    console.log("[WEBHOOK] sendText resp:", resp);

    res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e);
    res.status(200).send("ok");
  }
});

// ============== Broadcast (cron + debug) ==============
const CRON_EXPR = process.env.BROADCAST_CRON || "55 22 * * *";
const CRON_TZ   = process.env.BROADCAST_TZ   || "Asia/Ho_Chi_Minh";

async function broadcastOnce(text) {
  const list = await loadSubscribers();
  if (!list.length) {
    console.log("[BROADCAST] No subscribers. Skip.");
    return { total: 0, sent: 0, failed: 0 };
  }
  let sent = 0, failed = 0;
  for (const uid of list) {
    try {
      const r = await safeSendText(uid, text);
      if (r?.error === 0) sent++; else failed++;
      await new Promise(r => setTimeout(r, 150));
    } catch {
      failed++;
    }
  }
  console.log(`[BROADCAST] Done. total=${list.length}, sent=${sent}, failed=${failed}`);
  return { total: list.length, sent, failed };
}

try {
  console.log(`[CRON] schedule: ${CRON_EXPR} TZ: ${CRON_TZ}`);
  cron.schedule(
    CRON_EXPR,
    async () => {
      const text = process.env.BROADCAST_TEXT || "📣 Thông báo từ OA";
      await broadcastOnce(text);
    },
    { timezone: CRON_TZ }
  );
} catch (e) {
  console.warn("[CRON] cannot schedule:", e.message);
}

// ============== Debug routes ==============
// Xem danh sách subscribers
app.get("/debug/subscribers", async (req, res) => {
  try {
    if (process.env.DEBUG_TOKEN) {
      const tok = req.query.token || req.headers["x-debug-token"];
      if (tok !== process.env.DEBUG_TOKEN) return res.status(401).json({ error: "unauthorized" });
    }
    const list = await loadSubscribers();
    return res.json({ count: list.length, sample: list.slice(0, 10) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Ping 1 user: /debug/ping?uid=xxx&text=Hello
app.get("/debug/ping", async (req, res) => {
  try {
    if (process.env.DEBUG_TOKEN) {
      const tok = req.query.token || req.headers["x-debug-token"];
      if (tok !== process.env.DEBUG_TOKEN) return res.status(401).json({ error: "unauthorized" });
    }
    const uid  = req.query.uid;
    const text = req.query.text || "Ping";
    if (!uid) return res.status(400).json({ error: "uid required" });

    const resp = await safeSendText(String(uid), String(text));
    return res.json(resp);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Xem KB đang nạp
app.get("/debug/kb", async (_req, res) => {
  try {
    return res.json({
      count: KB_DOCS.length,
      titles: KB_DOCS.slice(0, 10).map(d => d.title),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ============== START ==============
const port = process.env.PORT || 3000;
console.log("Gemini key prefix:", (process.env.GOOGLE_API_KEY || "").slice(0, 4));
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
