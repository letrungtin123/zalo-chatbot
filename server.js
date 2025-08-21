// server.js
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import cron from "node-cron";

import { ensureAccessToken } from "./zaloOAuth.js";
import { sendText } from "./zaloApi.js";
import { generateReply } from "./gemini.js"; // fallback nếu KB/FAQ không đáp ứng

// ----------------- Base setup -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(bodyParser.json());

// static + optional verify folder
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.use("/verify", express.static(publicDir));
}

// health
app.get("/health", (_req, res) => res.status(200).send("OK"));

// webhook GET verify (nếu cần)
app.get("/webhook", (req, res) => {
  const verifyToken = process.env.VERIFY_TOKEN || "";
  if (verifyToken && req.query?.verify_token === verifyToken) {
    return res.status(200).send("verified");
  }
  if (req.query?.challenge) return res.status(200).send(req.query.challenge);
  res.status(200).send("ok");
});

// ----------------- Load company info -----------------
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

// ----------------- Subscribers store (Upstash/FILE) -----------------
const SUBS_FILE = path.join(__dirname, "subscribers.json");
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REST_URL || "";
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REST_TOKEN || "";
const SUBS_KEY = process.env.SUBSCRIBERS_KEY || "zalo:subscribers";

async function addSubscriber(userId) {
  if (!userId) return;
  // prefer upstash
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const url = `${UPSTASH_URL}/sadd/${encodeURIComponent(
        SUBS_KEY
      )}/${encodeURIComponent(String(userId))}`;
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
      return;
    } catch (e) {
      console.error("[SUBS] upstash sadd error:", e.message);
    }
  }
  // fallback file
  try {
    let arr = [];
    if (fs.existsSync(SUBS_FILE)) {
      arr = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
      if (!Array.isArray(arr)) arr = [];
    }
    const id = String(userId);
    if (!arr.includes(id)) {
      arr.push(id);
      fs.writeFileSync(SUBS_FILE, JSON.stringify(arr, null, 2), "utf8");
    }
  } catch (e) {
    console.error("[SUBS] file add error:", e.message);
  }
}

async function loadSubscribers() {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const url = `${UPSTASH_URL}/smembers/${encodeURIComponent(SUBS_KEY)}`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
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

// ----------------- Knowledge Base from API -----------------
const INTRO_BASE = process.env.INTRO_API_BASE || "";
const INTRO_PATH = process.env.INTRO_API_PATH || "/api/Introduce/list";
const INTRO_TIMEOUT = parseInt(process.env.INTRO_API_TIMEOUT || "8000", 10);
const INTRO_TTL = parseInt(process.env.INTRO_CACHE_TTL || "600000", 10); // 10m

const stripHtml = (html = "") =>
  String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

class KnowledgeBase {
  constructor() {
    this.docs = []; // { id, title, text }
    this.last = 0;
  }
  get stale() {
    return Date.now() - this.last > INTRO_TTL;
  }
  async refresh(force = false) {
    if (!INTRO_BASE) return;
    if (!force && !this.stale && this.docs.length) return;

    const url = `${INTRO_BASE}${INTRO_PATH}`;
    console.log("[KB] fetching:", url);
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), INTRO_TIMEOUT);
      const r = await fetch(url, { signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`KB HTTP ${r.status}`);
      const j = await r.json();
      const data = Array.isArray(j?.data) ? j.data : [];
      this.docs = data.map((it) => ({
        id: it.id,
        title: String(it.title || "Tài liệu"),
        text: stripHtml(it.content || ""),
      }));
      this.last = Date.now();
      console.log("[KB] refreshed. docs=" + this.docs.length);
    } catch (e) {
      console.warn("[KB] refresh error:", e.message || e);
    }
  }
  list() {
    return this.docs.slice();
  }
}

const KB = new KnowledgeBase();
KB.refresh(true).then(() => console.log("[KB] loaded"));

// ----------------- Text helpers & Answerers -----------------
const norm = (s = "") =>
  s.toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();

function summarize(text = "", max = 700) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;

  const sentences = t.split(/(?<=[\.\!\?])\s+/);
  let out = "";
  for (const s of sentences) {
    if (!s) continue;
    if ((out + (out ? " " : "") + s).length > max) break;
    out += (out ? " " : "") + s;
  }
  if (!out) out = t.slice(0, max);
  return out.trim() + "…";
}

function formatKbReply(doc) {
  const summary = summarize(doc.text || "", 700);
  const hasContact = companyInfo?.hotline || companyInfo?.email;
  const footer = hasContact
    ? `\n\n📞 Liên hệ: ${companyInfo?.hotline || ""}${
        companyInfo?.email ? " • " + companyInfo.email : ""
      }`
    : "";
  // KHÔNG dùng “mình tìm được…”, chỉ nêu tiêu đề + nội dung gọn
  return `📘 ${doc.title}\n\n${summary}${footer}\n\nBạn cần chi tiết? Nhắn: "chi tiết ${doc.title.toLowerCase()}"`;
}

function tryCompanyInfoAnswer(userText) {
  if (!companyInfo) return null;
  const t = norm(userText);

  // chào hỏi
  if (/^(hi|hello|xin chào|chào|helo|heloo)\b/i.test(userText)) {
    const name = companyInfo.name || "OA";
    return (
      `Xin chào! Bạn đang trò chuyện với **${name}**.\n` +
      `Bạn có thể hỏi: *tên công ty*, *địa chỉ*, *giờ làm*, *liên hệ*, *chính sách bảo hành*…`
    );
  }

  // theo FAQ
  if (Array.isArray(companyInfo.faq)) {
    for (const item of companyInfo.faq) {
      const qs = Array.isArray(item.q) ? item.q : item.q ? [item.q] : [];
      const hit = qs.some((k) => t.includes(norm(k)));
      if (hit && item.a) return String(item.a);
    }
  }

  // intent phổ biến
  if (t.includes("tên công ty")) {
    return `🏢 Tên công ty: **${companyInfo.name || "chưa thiết lập"}**`;
  }
  if (/(địa chỉ|ở đâu|văn phòng)/.test(t)) {
    return `📍 Địa chỉ: ${companyInfo.address || "chưa thiết lập"}`;
  }
  if (/(giờ làm|thời gian làm việc|mở cửa)/.test(t)) {
    return `⏰ Giờ làm việc: ${companyInfo.working_hours || "chưa thiết lập"}`;
  }
  if (/(liên hệ|hotline|số điện thoại|contact)/.test(t)) {
    const hotline = companyInfo.hotline ? `Hotline: ${companyInfo.hotline}` : "";
    const email = companyInfo.email
      ? (hotline ? " • " : "") + `Email: ${companyInfo.email}`
      : "";
    return `📞 ${hotline}${email}` || "📞 Thông tin liên hệ hiện chưa thiết lập.";
  }
  return null;
}

function tryKbAnswer(userText) {
  const docs = KB.list();
  if (!docs.length) return null;
  const t = norm(userText);

  // “chi tiết …”
  const mDetail = /chi ?ti[eê]t\s+(.+)/i.exec(userText);
  if (mDetail) {
    const q = norm(mDetail[1]);
    const doc =
      docs.find((d) => norm(d.title).includes(q)) ||
      docs.find((d) => (d.text || "").toLowerCase().includes(q)) ||
      null;
    if (doc) {
      const long = summarize(doc.text || "", 1600);
      return formatKbReply({ ...doc, text: long });
    }
  }

  // ưu tiên các nhóm
  const priority = [
    { key: "bảo hành", re: /bảo hành/i },
    { key: "giới thiệu", re: /giới thiệu/i },
    { key: "lỗi", re: /lỗi|ngoài điều kiện/i },
  ];
  let doc = null;
  for (const p of priority) {
    if (t.includes(p.key)) {
      doc = docs.find((d) => p.re.test(d.title));
      if (doc) break;
    }
  }
  if (!doc) doc = docs.find((d) => norm(d.title).includes(t)) || null;
  if (!doc && t.length >= 8)
    doc = docs.find((d) => (d.text || "").toLowerCase().includes(t)) || null;
  if (!doc) doc = docs.find((d) => /giới thiệu/i.test(d.title)) || docs[0];
  if (!doc) return null;
  return formatKbReply(doc);
}

// ----------------- Zalo helpers -----------------
function extractIncoming(evt) {
  const userId =
    evt?.sender?.id || evt?.sender?.user_id || evt?.user?.user_id || null;

  const text =
    evt?.message?.text ||
    evt?.message?.content?.text ||
    evt?.text ||
    null;

  return { userId, text, event_name: evt?.event_name };
}

async function safeSendText(userId, text) {
  const accessToken = await ensureAccessToken().catch((e) => {
    console.error("[ACCESS] error", e);
    return null;
  });
  if (!accessToken) return { error: -1, message: "no access token" };
  try {
    const r = await sendText(accessToken, userId, text);
    if (r?.error !== 0) {
      console.error("Zalo send error:", r);
    }
    return r;
  } catch (e) {
    console.error("Zalo send exception:", e.message);
    return { error: -99, message: e.message };
  }
}

// ---------- Auto prefix for all outgoing messages ----------
const AUTO_PREFIX =
  process.env.AUTO_PREFIX || "🤖 Đây là tin nhắn tự động của chatbot.";
function withAutoPrefix(text) {
  const t = String(text || "").trim();
  if (!t) return AUTO_PREFIX;
  if (
    t.startsWith(AUTO_PREFIX) ||
    t.startsWith("🤖 Đây là tin nhắn tự động") ||
    t.startsWith("Đây là tin nhắn tự động")
  ) {
    return t;
  }
  return `${AUTO_PREFIX}\n\n${t}`;
}

// ----------------- Webhook -----------------
app.post("/webhook", async (req, res) => {
  try {
    await KB.refresh(); // refresh nhẹ theo TTL
    const event = req.body || {};
    const { userId, text, event_name } = extractIncoming(event);
    console.log(
      "[WEBHOOK] incoming:",
      JSON.stringify({ event_name, userId, text })
    );

    if (userId && (event_name === "user_follow" || event_name === "user_send_text")) {
      await addSubscriber(userId);
    }

    if (event_name !== "user_send_text") {
      return res.status(200).send("ok");
    }
    if (!userId || !text) return res.status(200).send("ignored");

    // 1) company info nhanh – chuyên nghiệp
    let reply = tryCompanyInfoAnswer(text);

    // 2) KB API (giới thiệu/bảo hành/…)
    if (!reply) reply = tryKbAnswer(text);

    // 3) fallback Gemini (nếu có KEY), nếu lỗi -> template chung
    if (!reply) {
      try {
        const sys = [
          "Bạn là trợ lý ngắn gọn, trả lời lịch sự, không quá 4 câu.",
          companyInfo?.name ? `Tên công ty: ${companyInfo.name}` : "",
          companyInfo?.hotline ? `Hotline: ${companyInfo.hotline}` : "",
          companyInfo?.email ? `Email: ${companyInfo.email}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        reply = await generateReply([], text, { system: sys });
      } catch (e) {
        console.error("[Gemini] error:", e.message || e);
        reply =
          "Xin lỗi, hiện mình chưa có thông tin đó. Bạn có thể hỏi về *tên công ty, địa chỉ, giờ làm, liên hệ, chính sách bảo hành…*";
      }
    }

    // Thêm prefix tự động trước khi gửi
    const finalMsg = withAutoPrefix(reply);
    const resp = await safeSendText(userId, finalMsg);
    console.log("[WEBHOOK] sendText resp:", resp);
    res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e);
    res.status(200).send("ok");
  }
});

// ----------------- Broadcast (cron + debug) -----------------
const CRON_EXPR = process.env.BROADCAST_CRON || "0 * * * *"; // mặc định mỗi giờ
const CRON_TZ = process.env.BROADCAST_TZ || "Asia/Ho_Chi_Minh";

// 24 thông điệp – có thể override bằng env BROADCAST_TEXTS (JSON array)
const HOURLY_TEXTS =
  (process.env.BROADCAST_TEXTS &&
    (() => {
      try {
        return JSON.parse(process.env.BROADCAST_TEXTS);
      } catch {
        return null;
      }
    })()) ||
  [
    "Chúc buổi sáng tốt lành!",
    "Nhớ uống nước nhé!",
    "Chúc bạn làm việc hiệu quả!",
    "Giải lao chút cho khoẻ nhé!",
    "Hỏi mình nếu bạn cần trợ giúp.",
    "Cảm ơn bạn đã theo dõi OA.",
    "Giữ gìn sức khoẻ nha!",
    "Luôn tích cực và lạc quan!",
    "Cần thông tin bảo hành? Hỏi mình.",
    "Đã đến giờ vận động nhẹ!",
    "Bạn có câu hỏi về sản phẩm?",
    "Chúc bạn buổi trưa vui vẻ!",
    "Cảm ơn bạn đã đồng hành cùng OA.",
    "Nếu cần hỗ trợ kỹ thuật, nhắn mình nhé.",
    "Luôn sẵn sàng hỗ trợ bạn!",
    "Đừng quên giãn cơ một chút.",
    "Bạn muốn biết thêm về dịch vụ?",
    "Chúc bạn buổi chiều hiệu quả!",
    "Giữ năng lượng tích cực nhé!",
    "Cần liên hệ nhanh: hỏi ‘liên hệ’.",
    "Chúc bạn buổi tối thư giãn!",
    "Hỏi ‘bảo hành’ để xem chính sách.",
    "Có thể hỏi ‘giới thiệu’ để biết thêm.",
    "Chúc ngủ ngon và hẹn gặp lại!",
  ];

function hourIndex(date = new Date()) {
  const tz = CRON_TZ || "Asia/Ho_Chi_Minh";
  try {
    const s = date.toLocaleString("sv-SE", { timeZone: tz });
    const h = new Date(s.replace(" ", "T")).getHours();
    return h % 24;
  } catch {
    return date.getHours() % 24;
  }
}

async function broadcastOnce(text) {
  const list = await loadSubscribers();
  if (!list.length) {
    console.log("[BROADCAST] No subscribers.");
    return { total: 0, sent: 0, failed: 0 };
  }
  const accessToken = await ensureAccessToken().catch((e) => {
    console.error("[BROADCAST] access error:", e.message || e);
    return null;
  });
  if (!accessToken) return { total: list.length, sent: 0, failed: list.length };

  const payload = withAutoPrefix(text); // thêm prefix cho broadcast
  let sent = 0,
    failed = 0;
  for (const uid of list) {
    try {
      const r = await sendText(accessToken, uid, payload);
      if (r?.error === 0) sent++;
      else failed++;
      await new Promise((r) => setTimeout(r, 120));
    } catch {
      failed++;
    }
  }
  console.log(
    `[BROADCAST] Done. total=${list.length}, sent=${sent}, failed=${failed}`
  );
  return { total: list.length, sent, failed };
}

try {
  console.log(`[CRON] schedule: ${CRON_EXPR} TZ: ${CRON_TZ}`);
  cron.schedule(
    CRON_EXPR,
    async () => {
      const idx = hourIndex();
      const text =
        (Array.isArray(HOURLY_TEXTS) && HOURLY_TEXTS[idx]) ||
        process.env.BROADCAST_TEXT ||
        "🔔 Thông báo từ OA.";
      await broadcastOnce(text);
    },
    { timezone: CRON_TZ }
  );
} catch (e) {
  console.warn("[CRON] cannot schedule:", e.message);
}

// ----------------- Debug routes -----------------
app.get("/debug/subscribers", async (req, res) => {
  try {
    const key = process.env.ADMIN_KEY || process.env.DEBUG_TOKEN;
    if (key && (req.query.key || req.headers["x-admin-key"]) !== key)
      return res.status(401).json({ error: "unauthorized" });

    const list = await loadSubscribers();
    res.json({ count: list.length, sample: list.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/debug/broadcast", async (req, res) => {
  try {
    const key = process.env.ADMIN_KEY || process.env.DEBUG_TOKEN;
    if (key && (req.query.key || req.headers["x-admin-key"]) !== key)
      return res.status(401).json({ error: "unauthorized" });

    const text =
      (req.body?.text || req.query.text || process.env.BROADCAST_TEXT)?.toString() ||
      "🔔 Thông báo từ OA.";
    const result = await broadcastOnce(text); // đã tự thêm prefix bên trong
    res.json({ text: withAutoPrefix(text), ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------- Start -----------------
const port = process.env.PORT || 3000;
console.log("Gemini key prefix:", (process.env.GOOGLE_API_KEY || "").slice(0, 4));
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
