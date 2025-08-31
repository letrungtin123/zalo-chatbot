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
import { generateReply } from "./gemini.js";

import { getTopics, getQAByTopic, getSchedules } from "./chatboxApi.js";
import { setState, getState, clearState } from "./sessionStore.js";

// ----------------- Base setup -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(bodyParser.json());

const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.use("/verify", express.static(publicDir));
}

app.get("/health", (_req, res) => res.status(200).send("OK"));

app.get("/webhook", (req, res) => {
  const verifyToken = process.env.VERIFY_TOKEN || "";
  if (verifyToken && req.query?.verify_token === verifyToken) {
    return res.status(200).send("verified");
  }
  if (req.query?.challenge) return res.status(200).send(req.query.challenge);
  res.status(200).send("ok");
});

// ----------------- Company info -----------------
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

// ----------------- Subscribers store (file/upstash) -----------------
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

// ----------------- KB giản lược (giữ nguyên code cũ) -----------------
const INTRO_BASE = process.env.INTRO_API_BASE || "";
const INTRO_PATH = process.env.INTRO_API_PATH || "/api/Introduce/list";
const INTRO_TIMEOUT = parseInt(process.env.INTRO_API_TIMEOUT || "8000", 10);
const INTRO_TTL = parseInt(process.env.INTRO_CACHE_TTL || "600000", 10);
const stripHtml = (html = "") =>
  String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

class KnowledgeBase {
  constructor() {
    this.docs = [];
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

// ----------------- Helpers & default answerers -----------------
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

function tryCompanyInfoAnswer(userText) {
  if (!companyInfo) return null;
  const t = norm(userText);

  if (/^(hi|hello|xin chào|chào|helo|heloo)\b/i.test(userText)) {
    const name = companyInfo.name || "OA";
    return (
      `Xin chào! Bạn đang trò chuyện với **${name}**.\n` +
      `Bạn có thể hỏi: *tên công ty*, *địa chỉ*, *giờ làm*, *liên hệ*, *chính sách bảo hành*…`
    );
  }

  if (Array.isArray(companyInfo.faq)) {
    for (const item of companyInfo.faq) {
      const qs = Array.isArray(item.q) ? item.q : item.q ? [item.q] : [];
      const hit = qs.some((k) => t.includes(norm(k)));
      if (hit && item.a) return String(item.a);
    }
  }

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
    const hotline = companyInfo.hotline
      ? `Hotline: ${companyInfo.hotline}`
      : "";
    const email = companyInfo.email
      ? (hotline ? " • " : "") + `Email: ${companyInfo.email}`
      : "";
    return (
      `📞 ${hotline}${email}` || "📞 Thông tin liên hệ hiện chưa thiết lập."
    );
  }
  return null;
}

function tryKbAnswer(userText) {
  const docs = KB.list();
  if (!docs.length) return null;
  const t = norm(userText);
  const mDetail = /chi ?ti[eê]t\s+(.+)/i.exec(userText);
  if (mDetail) {
    const q = norm(mDetail[1]);
    const doc =
      docs.find((d) => norm(d.title).includes(q)) ||
      docs.find((d) => (d.text || "").toLowerCase().includes(q)) ||
      null;
    if (doc) {
      const long = summarize(doc.text || "", 1600);
      return `📘 ${doc.title}\n\n${long}`;
    }
  }
  let doc = docs.find((d) => norm(d.title).includes(t)) || null;
  if (!doc && t.length >= 8)
    doc = docs.find((d) => (d.text || "").toLowerCase().includes(t)) || null;
  if (!doc) doc = docs.find((d) => /giới thiệu/i.test(d.title)) || docs[0];
  if (!doc) return null;
  const summary = summarize(doc.text || "", 700);
  return `📘 ${doc.title}\n\n${summary}`;
}

// ----------------- Zalo helpers -----------------
function extractIncoming(evt) {
  const userId =
    evt?.sender?.id || evt?.sender?.user_id || evt?.user?.user_id || null;
  const text =
    evt?.message?.text || evt?.message?.content?.text || evt?.text || null;
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

// ---------- Auto prefix ----------
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

function isThanksOrOk(userText = "") {
  const t = norm(userText);
  if (/^(ok|oke|okay|oki|okie)\b/.test(t)) return true;
  if (/(cảm ơn|cam on|thanks|thank you)/.test(t)) return true;
  return false;
}

// ----------------- ChatboxAIQA FLOW -----------------
function renderTopicsMsg(topics) {
  if (!topics?.length) return "Hiện chưa có chủ đề nào.";
  const lines = topics.map((t, i) => `${i + 1}. ${t.name}`);
  return ["", ...lines, "", `💞Vui lòng "Gõ số hoặc tên" nhé:`].join("\n");
}

function renderQuestionsMsg(topicName, qas) {
  if (!qas?.length) return `Chủ đề **${topicName}** hiện chưa có câu hỏi.`;
  const lines = qas.map((q, i) => `${i + 1}. ${q.question}`);
  return [
    `Chủ đề: **${topicName}**`,
    "Chọn **Câu hỏi** (gõ số hoặc trích nội dung):",
    "",
    ...lines,
  ].join("\n");
}

function parsePick(text, list, fields = ["name", "question"]) {
  // ưu tiên chọn theo số
  const n = Number(text?.trim());
  if (Number.isInteger(n) && n >= 1 && n <= list.length) {
    return list[n - 1];
  }
  // hoặc theo tên/string match 1 phần
  const t = norm(text || "");
  let best = null,
    bestScore = 0;
  for (const it of list) {
    const hay = fields.map((f) => norm(String(it[f] || ""))).join(" ");
    let score = 0;
    t.split(/\s+/).forEach((tok) => {
      if (tok && hay.includes(tok)) score++;
    });
    if (score > bestScore) {
      best = it;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

// ----------------- Webhook -----------------
app.post("/webhook", async (req, res) => {
  try {
    await KB.refresh();

    const event = req.body || {};
    const { userId, text, event_name } = extractIncoming(event);
    console.log(
      "[WEBHOOK] incoming:",
      JSON.stringify({ event_name, userId, text })
    );

    if (
      userId &&
      (event_name === "user_follow" || event_name === "user_send_text")
    ) {
      await addSubscriber(userId);
    }
    if (event_name !== "user_send_text") {
      return res.status(200).send("ok");
    }
    if (!userId || !text) return res.status(200).send("ignored");

    // 0) “ok / cảm ơn”
    if (isThanksOrOk(text)) {
      const ack =
        "Cảm ơn bạn đã quan tâm, theo dõi và sử dụng dịch vụ của công ty JW Kim 💞";
      await safeSendText(userId, withAutoPrefix(ack));
      return res.status(200).send("ok");
    }

    // ====== ChatboxAIQA state machine ======
    // State: null -> hỏi danh sách Topic
    // State: awaiting_topic -> nhận topic (số/tên) => load QAs => hỏi danh sách QAs
    // State: awaiting_question -> trả lời câu hỏi
    const state = getState(userId);

    // Nhận lệnh reset
    if (/^(hủy|thoát|reset|bắt đầu|menu)$/i.test(text)) {
      clearState(userId);
    }

    // 1) Chưa có state → render topics
    if (!getState(userId)) {
      const topics = await getTopics();
      setState(userId, { stage: "awaiting_topic", topics });
      const msg = renderTopicsMsg(topics);
      await safeSendText(userId, withAutoPrefix(msg));
      return res.status(200).send("ok");
    }

    // 2) Đang chọn Topic
    if (state.stage === "awaiting_topic") {
      const topics = state.topics || (await getTopics());
      const picked = parsePick(text, topics, ["name"]);
      if (!picked) {
        const msg =
          "Mình chưa nhận ra chủ đề bạn chọn. Vui lòng gõ **số** hoặc **tên** chủ đề.";
        await safeSendText(
          userId,
          withAutoPrefix(msg + "\n\n" + renderTopicsMsg(topics))
        );
        return res.status(200).send("ok");
      }
      // load QAs
      const qas = await getQAByTopic(picked.id);
      setState(userId, { stage: "awaiting_question", topic: picked, qas });
      const msg = renderQuestionsMsg(picked.name, qas);
      await safeSendText(userId, withAutoPrefix(msg));
      return res.status(200).send("ok");
    }

    // 3) Đang chọn Câu hỏi
    if (state.stage === "awaiting_question") {
      const qas = state.qas || [];
      const pickedQ = parsePick(text, qas, ["question"]);
      if (!pickedQ) {
        const msg =
          "Mình chưa nhận ra câu hỏi bạn chọn. Gõ **số** câu hỏi hoặc trích nội dung.";
        await safeSendText(
          userId,
          withAutoPrefix(
            msg + "\n\n" + renderQuestionsMsg(state.topic?.name || "", qas)
          )
        );
        return res.status(200).send("ok");
      }
      // Trả lời
      const answer =
        pickedQ.answer || "Xin lỗi, câu trả lời chưa được cấu hình.";
      await safeSendText(userId, withAutoPrefix(answer));

      // Hỏi tiếp trong cùng topic
      const follow =
        "Bạn muốn hỏi thêm trong chủ đề hiện tại không? Nếu có, gõ số câu hỏi tiếp theo.\nNếu muốn đổi chủ đề, gõ: **menu**";
      await safeSendText(userId, withAutoPrefix(follow));
      // Giữ state để user chọn câu khác, hoặc gõ "menu" để reset
      return res.status(200).send("ok");
    }

    // ===== Fallbacks (nếu vì lý do gì state không khớp) =====
    // company info nhanh
    let reply = tryCompanyInfoAnswer(text);
    if (!reply) reply = tryKbAnswer(text);
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
        reply = "Xin lỗi, hiện mình chưa có thông tin đó.";
      }
    }
    await safeSendText(userId, withAutoPrefix(reply));
    return res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e);
    res.status(200).send("ok");
  }
});

// ----------------- Broadcast (cron) -----------------
const CRON_EXPR = process.env.BROADCAST_CRON || "0 * * * *";
const CRON_TZ = process.env.BROADCAST_TZ || "Asia/Ho_Chi_Minh";

const HOURLY_TEXTS = (process.env.BROADCAST_TEXTS &&
  (() => {
    try {
      return JSON.parse(process.env.BROADCAST_TEXTS);
    } catch {
      return null;
    }
  })()) || [
  "⏰ 00:00 – Chúc bạn một đêm ngon giấc! Có gì cần hỗ trợ, cứ nhắn cho Công Ty JW Kim nhé.",
  "⏰ 01:00 – Cảm ơn bạn đã theo dõi Công Ty JW Kim. Chúc bạn ngủ ngon!",
  "⏰ 02:00 – Đội ngũ trực hệ thống 24/7. Cần gì bạn cứ nhắn tin.",
  "⏰ 03:00 – Chúc bạn buổi đêm yên tĩnh. Công Ty JW Kim luôn sẵn sàng hỗ trợ.",
  "⏰ 04:00 – Chuẩn bị cho một ngày mới tuyệt vời nhé!",
  "⏰ 05:00 – Chúc buổi sáng tốt lành 🌤️",
  "⏰ 06:00 – Khởi động ngày mới thật năng lượng!",
  "⏰ 07:00 – Chúc bạn một ngày làm việc hiệu quả!",
  "⏰ 08:00 – Nếu cần tư vấn, cứ nhắn Công Ty JW Kim ngay nhé.",
  "⏰ 09:00 – Công Ty JW Kim có thể trợ giúp bạn về thông tin dịch vụ bất cứ lúc nào.",
  "⏰ 10:00 – Đừng quên uống nước và thư giãn một chút!",
  "⏰ 11:00 – Gần trưa rồi, chúc bạn bữa trưa ngon miệng 🍽️",
  "⏰ 12:00 – Trưa tốt lành! Cần hỗ trợ gấp? Hãy reply tin nhắn này.",
  "⏰ 13:00 – Buổi chiều thật nhiều năng lượng nhé!",
  "⏰ 14:00 – Công Ty JW Kim luôn sẵn sàng trả lời câu hỏi của bạn.",
  "⏰ 15:00 – Nghỉ ngơi 5 phút cho tỉnh táo nào ☕",
  '⏰ 16:00 – Nếu bạn muốn biết thêm về dịch vụ, hãy nhắn "dịch vụ".',
  "⏰ 17:00 – Sắp hết giờ làm, bạn cần Công Ty JW Kim hỗ trợ gì không?",
  "⏰ 18:00 – Chúc bạn buổi tối vui vẻ!",
  "⏰ 19:00 – Có câu hỏi nào cho Công Ty JW Kim không? Cứ nhắn nhé.",
  '⏰ 20:00 – Công Ty JW Kim có nhiều thông tin hữu ích, thử hỏi: "liên hệ", "giờ làm", "địa chỉ"…',
  "⏰ 21:00 – Chúc bạn buổi tối thư giãn.",
  "⏰ 22:00 – Đừng quên nghỉ ngơi sớm để mai thật khoẻ nhé!",
  "⏰ 23:00 – Kết thúc ngày thật nhẹ nhàng. Công Ty JW Kim luôn ở đây 🤝",
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

  const payload = withAutoPrefix(text);
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

async function pickScheduleTextForNow() {
  try {
    const hhmm = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: CRON_TZ || "Asia/Ho_Chi_Minh",
    });
    const list = await getSchedules(); // [{sendTime:"HH:mm", message:"..."}]
    const hits = list.filter((x) => x.sendTime === hhmm);
    if (hits.length) {
      // nếu nhiều thì ghép lại
      return hits.map((x) => x.message).join("\n\n");
    }
    return null;
  } catch (e) {
    console.warn("[SCHEDULE] fetch error:", e.message);
    return null;
  }
}

try {
  console.log(`[CRON] schedule: ${CRON_EXPR} TZ: ${CRON_TZ}`);
  cron.schedule(
    CRON_EXPR,
    async () => {
      const scheduleText = await pickScheduleTextForNow();
      const idx = hourIndex();
      const fallback =
        (Array.isArray(HOURLY_TEXTS) && HOURLY_TEXTS[idx]) ||
        process.env.BROADCAST_TEXT ||
        "🔔 Thông báo từ OA.";
      await broadcastOnce(scheduleText || fallback);
    },
    { timezone: CRON_TZ }
  );
} catch (e) {
  console.warn("[CRON] cannot schedule:", e.message);
}

// ----------------- Debug routes giữ nguyên -----------------
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
      (
        req.body?.text ||
        req.query.text ||
        process.env.BROADCAST_TEXT
      )?.toString() || "🔔 Thông báo từ OA.";
    const result = await broadcastOnce(text);
    res.json({ text: withAutoPrefix(text), ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------- Start -----------------
const port = process.env.PORT || 3000;
console.log(
  "Gemini key prefix:",
  (process.env.GOOGLE_API_KEY || "").slice(0, 4)
);
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
