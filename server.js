// server.js
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import cron from "node-cron";

import { sendText } from "./zaloApi.js";        // /v3.0/oa/message/cs (header access_token)
import { generateReply } from "./gemini.js";    // fallback LLM
import { ensureAccessToken } from "./zaloOAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", true);
app.use(bodyParser.json({ limit: "1mb" }));

// ================== Static & Verify file (tuỳ chọn) ==================
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));            // https://host/<file>
  app.use("/verify", express.static(publicDir)); // https://host/verify/<file>
}

// Nếu bạn muốn verify qua 1 URL cố định do ENV cung cấp:
const VERIFY_FILENAME = process.env.ZALO_VERIFY_FILENAME || "";
const VERIFY_CONTENT  = process.env.ZALO_VERIFY_CONTENT  || "";
if (VERIFY_FILENAME) {
  const verifyPath = "/" + VERIFY_FILENAME.replace(/^\//, "");
  app.get(verifyPath, (_req, res) => {
    if (VERIFY_CONTENT) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(VERIFY_CONTENT);
    }
    const onDisk = path.join(publicDir, VERIFY_FILENAME);
    if (fs.existsSync(onDisk)) return res.sendFile(onDisk);
    return res.status(404).send("Verifier file not found.");
  });
}

// ================== Company Info (local JSON) ==================
let companyInfo = null;
const companyInfoPath = path.join(__dirname, "companyInfo.json");
try {
  if (fs.existsSync(companyInfoPath)) {
    companyInfo = JSON.parse(fs.readFileSync(companyInfoPath, "utf8"));
    console.log("Loaded companyInfo.json");
  }
} catch (e) {
  console.warn("⚠️ Cannot load companyInfo.json:", e.message);
}

// ================== INTRO API (Knowledge Base) ==================
const INTRO_BASE    = process.env.INTRO_API_BASE || "";     // e.g. https://asianasa.com:8443
const INTRO_PATH    = process.env.INTRO_API_PATH || "";     // e.g. /api/Introduce/list
const INTRO_TIMEOUT = +process.env.INTRO_API_TIMEOUT || 8000;
const INTRO_TTL     = +process.env.INTRO_CACHE_TTL || 600000; // 10 phút

let KB = { docs: [], last: 0 };

function cleanHtmlToText(html = "") {
  try {
    // gỡ tag, decode thô HTML entities phổ biến
    const decoded = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return decoded;
  } catch {
    return "";
  }
}

async function fetchIntroDocs() {
  if (!INTRO_BASE || !INTRO_PATH) return;
  const url = `${INTRO_BASE}${INTRO_PATH}`;
  console.log("[KB] fetching:", url);

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort("timeout"), INTRO_TIMEOUT);

  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();

    const arr = Array.isArray(j?.data) ? j.data : [];
    const docs = arr.map((it) => ({
      id: String(it.id ?? ""),
      title: String(it.title ?? "Nội dung"),
      text: cleanHtmlToText(String(it.content ?? ""))
    })).filter(d => d.text);

    KB = { docs, last: Date.now() };
    console.log("[KB] refreshed. docs=" + docs.length);
  } catch (e) {
    clearTimeout(to);
    console.warn("[KB] refresh error:", e.message || e);
  }
}

function getKbDocs() {
  if (!KB.last || Date.now() - KB.last > INTRO_TTL) {
    fetchIntroDocs().catch(() => {});
  }
  return KB.docs || [];
}

// tải lần đầu + refetch định kỳ
fetchIntroDocs().catch(() => {});
setInterval(() => fetchIntroDocs().catch(() => {}), Math.max(60000, INTRO_TTL));

// ================== Subscribers Store (Upstash Redis / File) ==================
const SUBS_FILE = path.join(__dirname, "subscribers.json");
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.UPSTASH_REST_URL || "";
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.UPSTASH_REST_TOKEN || "";
const SUBS_KEY = process.env.SUBSCRIBERS_KEY || "zalo:subscribers";

async function addSubscriber(userId) {
  if (!userId) return;
  // Upstash ưu tiên
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const url = `${UPSTASH_URL}/sadd/${encodeURIComponent(SUBS_KEY)}/${encodeURIComponent(String(userId))}`;
      await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
      return;
    } catch (e) {
      console.error("[SUBS] upstash sadd error:", e.message);
    }
  }
  // File fallback
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
      const r = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
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

// ================== Helpers ==================
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

  return { userId, text };
}

const norm = (s = "") =>
  s.toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();

// Trả lời nhanh bằng companyInfo.faq
function tryCompanyInfoAnswer(userText) {
  if (!companyInfo) return null;
  const t = norm(userText);

  // khớp các FAQ cấu hình
  if (Array.isArray(companyInfo.faq)) {
    for (const item of companyInfo.faq) {
      const q = Array.isArray(item.q) ? item.q : (item.q ? [item.q] : []);
      const hit = q.some((k) => t.includes(norm(k)));
      if (hit && item.a) return String(item.a);
    }
  }

  // fallback vài intent phổ biến
  if (t.includes("tên công ty")) return `Tên công ty: ${companyInfo.name || "chưa thiết lập"}`;
  if (/(địa chỉ|ở đâu|văn phòng)/.test(t))
    return `Địa chỉ: ${companyInfo.address || "chưa thiết lập"}`;
  if (/(giờ làm|thời gian làm việc|mở cửa)/.test(t))
    return `Giờ làm việc: ${companyInfo.working_hours || "chưa thiết lập"}`;
  if (/(liên hệ|hotline|số điện thoại)/.test(t))
    return `Hotline: ${companyInfo.hotline || ""}${companyInfo.email ? " — Email: " + companyInfo.email : ""}`;

  return null;
}

// Trả lời nhanh bằng KB Introduce
function tryKbAnswer(userText) {
  const docs = getKbDocs();
  if (!docs.length) return null;

  const t = norm(userText);
  // heuristic: ưu tiên tiêu đề khớp keyword
  const order = [
    { key: "bảo hành", title: /bảo hành/i },
    { key: "giới thiệu", title: /giới thiệu/i },
    { key: "lỗi", title: /lỗi|ngoài điều kiện/i }
  ];

  let candidate = null;

  for (const d of docs) {
    const title = d.title || "";
    const text = d.text || "";
    const whole = `${title}\n${text}`.toLowerCase();

    // nếu user nhắc thẳng một từ khoá quan trọng
    if (order.some(o => t.includes(o.key) && o.title.test(title))) {
      candidate = d; break;
    }
    // nếu tiêu đề chứa đoạn người dùng hỏi
    if (norm(title).includes(t) && !candidate) candidate = d;

    // nếu nội dung chứa cụm truy vấn dài (>=8)
    if (t.length >= 8 && whole.includes(t) && !candidate) candidate = d;
  }

  // fallback: ưu tiên tài liệu có tiêu đề "Giới thiệu" nếu người dùng hỏi chung
  if (!candidate) {
    candidate = docs.find(d => /giới thiệu/i.test(d.title)) || docs[0];
  }

  if (!candidate) return null;

  const snippet = (candidate.text || "").slice(0, 900).trim();
  if (!snippet) return null;

  return `Mình tìm được trong mục "${candidate.title}":\n${snippet}\n\n(Trích từ tài liệu OA)`;
}

// safe send with token
async function safeSendText(userId, text) {
  try {
    const token = await ensureAccessToken();
    return await sendText(token, userId, text);
  } catch (e) {
    console.error("[send] error:", e?.message || e);
    return null;
  }
}

// ================== Health & Verify token ==================
app.get("/health", (_req, res) => res.status(200).send("OK"));

app.get("/webhook", (req, res) => {
  if (req.query?.verify_token === process.env.VERIFY_TOKEN) return res.send("verified");
  if (req.query?.challenge) return res.send(req.query.challenge);
  res.send("ok");
});

// OAuth callback (nếu dùng thủ công)
app.get("/oauth/callback", (req, res) => {
  const code = req.query.code || "";
  res.send(`<h3>OAuth callback</h3><p>Code: ${code}</p>`);
});

// ================== WEBHOOK ZALO V3 ==================
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body || {};
    const { event_name } = event || {};
    const { userId, text } = extractIncoming(event);

    console.log(
      "[WEBHOOK] incoming:",
      JSON.stringify({ event_name, userId, text }).slice(0, 300)
    );

    // Lưu subscriber khi follow/nhắn tin
    if (userId && (event_name === "user_follow" || event_name === "user_send_text")) {
      await addSubscriber(userId);
    }

    // Chỉ xử lý user_send_text
    if (event_name !== "user_send_text") {
      return res.status(200).send("ok");
    }

    if (!userId || !text) {
      return res.status(200).send("ignored");
    }

    // 1) Company Info
    let reply =
      tryCompanyInfoAnswer(text)
      // 2) KB Introduce
      || tryKbAnswer(text);

    // 3) Fallback Gemini
    if (!reply) {
      try {
        reply = await generateReply([], text, companyInfo);
      } catch (e) {
        console.error("[Gemini] error:", e?.message || e);
        reply = "Xin lỗi, hiện tại tôi chưa có thông tin phù hợp. Bạn có thể hỏi về: tên công ty, địa chỉ, giờ làm, liên hệ, chính sách bảo hành…";
      }
    }

    // Gửi trả lời
    const resp = await safeSendText(userId, reply);
    console.log("[WEBHOOK] sendText resp:", resp);
    return res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e);
    // vẫn trả 200 để Zalo không retry dồn dập
    return res.status(200).send("ok");
  }
});

// ================== BROADCAST (mỗi giờ) ==================
const CRON_EXPR = process.env.BROADCAST_CRON || "0 * * * *"; // mặc định: đầu mỗi giờ
const CRON_TZ   = process.env.BROADCAST_TZ   || "Asia/Ho_Chi_Minh";
const BROADCAST_FILE = path.join(__dirname, "broadcastTexts.json");

function loadBroadcastTexts() {
  // 1) file
  try {
    if (fs.existsSync(BROADCAST_FILE)) {
      const arr = JSON.parse(fs.readFileSync(BROADCAST_FILE, "utf8"));
      if (Array.isArray(arr) && arr.length) {
        console.log(`[BROADCAST] loaded from broadcastTexts.json (${arr.length})`);
        return arr.map(String);
      }
    }
  } catch (e) {
    console.warn("[BROADCAST] cannot load broadcastTexts.json:", e.message);
  }
  // 2) ENV JSON
  if (process.env.BROADCAST_TEXTS_JSON) {
    try {
      const arr = JSON.parse(process.env.BROADCAST_TEXTS_JSON);
      if (Array.isArray(arr) && arr.length) {
        console.log(`[BROADCAST] loaded from BROADCAST_TEXTS_JSON (${arr.length})`);
        return arr.map(String);
      }
    } catch (e) {
      console.warn("[BROADCAST] invalid BROADCAST_TEXTS_JSON:", e.message);
    }
  }
  // 3) ENV chuỗi với ||
  if (process.env.BROADCAST_TEXTS) {
    const arr = process.env.BROADCAST_TEXTS.split("||").map(s => s.trim()).filter(Boolean);
    if (arr.length) {
      console.log(`[BROADCAST] loaded from BROADCAST_TEXTS (${arr.length})`);
      return arr;
    }
  }
  // 4) ENV 1 dòng
  if (process.env.BROADCAST_TEXT) {
    console.log("[BROADCAST] single message from BROADCAST_TEXT");
    return [process.env.BROADCAST_TEXT];
  }
  // 5) fallback từ companyInfo
  if (companyInfo) {
    const name = companyInfo.name || "OA";
    const hotline = companyInfo.hotline ? ` • Hotline: ${companyInfo.hotline}` : "";
    const hours   = companyInfo.working_hours ? ` • Giờ làm việc: ${companyInfo.working_hours}` : "";
    console.log("[BROADCAST] fallback from companyInfo");
    return [`⏰ Thông báo tự động từ ${name}.${hotline}${hours}`];
  }
  return ["⏰ Thông báo tự động từ OA. Cần hỗ trợ, reply tin nhắn này!"];
}

let BROADCAST_TEXTS = loadBroadcastTexts();

function hourInTZ(tz) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: tz || CRON_TZ
  });
  return parseInt(fmt.format(new Date()), 10); // 0..23
}

function pickBroadcastText() {
  if (!BROADCAST_TEXTS?.length) BROADCAST_TEXTS = loadBroadcastTexts();
  const h = hourInTZ(CRON_TZ);
  const idx = h % BROADCAST_TEXTS.length;
  return BROADCAST_TEXTS[idx];
}

async function broadcastOnce(text) {
  const list = await loadSubscribers();
  if (!list.length) {
    console.log("[BROADCAST] No subscribers. Skip.");
    return { total: 0, sent: 0, failed: 0 };
  }
  let sent = 0, failed = 0;
  for (const uid of list) {
    const resp = await safeSendText(uid, text);
    if (resp?.error === 0) sent++;
    else failed++;
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`[BROADCAST] Done. total=${list.length}, sent=${sent}, failed=${failed}`);
  return { total: list.length, sent, failed };
}

try {
  console.log(`[CRON] schedule: ${CRON_EXPR} TZ: ${CRON_TZ}`);
  cron.schedule(
    CRON_EXPR,
    async () => {
      const text = pickBroadcastText();
      console.log(`[BROADCAST] ${new Date().toISOString()} -> "${text.slice(0, 100)}"`);
      await broadcastOnce(text);
    },
    { timezone: CRON_TZ }
  );
} catch (e) {
  console.warn("[CRON] cannot schedule:", e.message);
}

// ================== DEBUG ROUTES ==================

// xem subscriber count
app.get("/debug/subscribers", async (_req, res) => {
  const list = await loadSubscribers();
  res.json({ count: list.length, sample: list.slice(0, 20) });
});

// dry-run broadcast hoặc bắn thật có limit
// POST /debug/broadcast?dry=1&limit=10&text=...
app.post("/debug/broadcast", async (req, res) => {
  try {
    const dry   = req.query.dry === "1" || req.body?.dry === true;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const text  = (req.body?.text || req.query.text || pickBroadcastText()).toString();

    const all = await loadSubscribers();
    const list = limit ? all.slice(0, limit) : all;

    if (dry) {
      return res.json({ dry: true, total: all.length, willSend: list.length, text });
    }

    let sent = 0, failed = 0;
    const errors = [];
    for (const uid of list) {
      try {
        const resp = await safeSendText(uid, text);
        if (resp?.error === 0) sent++;
        else {
          failed++; errors.push({ uid, resp });
        }
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        failed++; errors.push({ uid, error: err?.message || String(err) });
      }
    }
    return res.json({ text, total: list.length, sent, failed, errors: errors.slice(0, 20) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// xem message sẽ gửi theo giờ hiện tại
app.get("/debug/broadcast-text", (_req, res) => {
  return res.json({
    hour: hourInTZ(CRON_TZ),
    totalTexts: BROADCAST_TEXTS.length,
    text: pickBroadcastText()
  });
});

// reload nội dung broadcast (sau khi bạn sửa broadcastTexts.json)
app.post("/debug/reload-broadcast-texts", (_req, res) => {
  BROADCAST_TEXTS = loadBroadcastTexts();
  return res.json({ reloaded: true, totalTexts: BROADCAST_TEXTS.length });
});

// xem nhanh KB
app.get("/debug/kb", (_req, res) => {
  const docs = getKbDocs();
  res.json({ docs: docs.map(d => ({ id: d.id, title: d.title, len: (d.text || "").length })) });
});

// ================== START ==================
const port = process.env.PORT || 3000;
console.log("Gemini key prefix:", (process.env.GOOGLE_API_KEY || "").slice(0, 4));
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
