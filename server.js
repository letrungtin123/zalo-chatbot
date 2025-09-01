// server.js
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import cron from "node-cron";

// imports nội bộ bạn đã có
import { ensureAccessToken } from "./zaloOAuth.js";
import { sendText } from "./zaloApi.js";
import { generateReply } from "./gemini.js";

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

// ----------------- Knowledge Base from API (KB) -----------------
const INTRO_BASE = process.env.INTRO_API_BASE || "";
const INTRO_PATH = process.env.INTRO_API_PATH || "/api/Introduce/list";
const INTRO_TIMEOUT = parseInt(process.env.INTRO_API_TIMEOUT || "8000", 10);
const INTRO_TTL = parseInt(process.env.INTRO_CACHE_TTL || "600000", 10); // 10m

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

// ----------------- Helpers & simple answerers -----------------
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
  return `📘 ${
    doc.title
  }\n\n${summary}${footer}\n\nBạn cần chi tiết? Nhắn: "chi tiết ${doc.title.toLowerCase()}"`;
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
    const hotline = companyInfo.hotline ? `Hotline: ${companyInfo.hotline}` : "";
    const email = companyInfo.email ? (hotline ? " • " : "") + `Email: ${companyInfo.email}` : "";
    return `📞 ${hotline}${email}` || "📞 Thông tin liên hệ hiện chưa thiết lập.";
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
      return formatKbReply({ ...doc, text: long });
    }
  }
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

// ---------- Auto prefix for outgoing messages ----------
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

// ----------------- Chatbox Scheduled (FE polling job) -----------------
const CHATBOX_API_BASE = (process.env.CHATBOX_API_BASE || "").replace(/\/$/, "");
const CHATBOX_TOPIC_PATH = process.env.CHATBOX_TOPIC_PATH || "/ChatboxAITopic";
const CHATBOX_QA_PATH = process.env.CHATBOX_QA_PATH || "/ChatboxAIQA";
const CHATBOX_SCHEDULE_PATH = process.env.CHATBOX_SCHEDULE_PATH || "/ChatboxAIScheduledMessage";

async function fetchScheduledMessages(page = 1, pageSize = 100) {
  try {
    if (!CHATBOX_API_BASE) return [];
    // If BE expects full path with /api prefix, ensure env CHATBOX_API_BASE includes it.
    const url = `${CHATBOX_API_BASE}${CHATBOX_SCHEDULE_PATH}?page=${page}&pageSize=${pageSize}`;
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(()=>"");
      throw new Error(`Scheduled GET ${res.status} ${txt}`);
    }
    const j = await res.json().catch(()=>null);
    if (!j) return [];
    if (Array.isArray(j.data)) return j.data;
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.items)) return j.items;
    return [];
  } catch (e) {
    console.error("[SCHEDULE] fetchScheduledMessages error:", e.message || e);
    return [];
  }
}

// fetch QA list by topicId (returns array)
async function fetchQaByTopic(topicId, page = 1, pageSize = 10) {
  try {
    if (!CHATBOX_API_BASE || !topicId) return [];
    const url = `${CHATBOX_API_BASE}${CHATBOX_QA_PATH}?page=${page}&pageSize=${pageSize}&topicId=${encodeURIComponent(topicId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(()=>"");
      console.warn(`[SCHEDULE] QA GET ${res.status} ${txt}`);
      return [];
    }
    const j = await res.json().catch(()=>null);
    if (!j) return [];
    if (Array.isArray(j.data)) return j.data;
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.items)) return j.items;
    return [];
  } catch (e) {
    console.error("[SCHEDULE] fetchQaByTopic error:", e.message || e);
    return [];
  }
}

// mark scheduled as sent: PUT to /ChatboxAIScheduledMessage/{id}
// We send a minimal payload that sets lastSentAt and optionally updatedAt.
// If your BE requires a strict model, adjust payload accordingly (e.g. isSent/status).
async function markScheduledMessageSent(record) {
  try {
    if (!CHATBOX_API_BASE) return null;
    if (!record || !record.id) return null;
    const id = record.id;
    const nowISO = new Date().toISOString();
    // Minimal payload to update lastSentAt (avoid sending full record which may have extra fields incompatible)
    const payload = { lastSentAt: nowISO, updatedAt: nowISO };
    const url = `${CHATBOX_API_BASE}${CHATBOX_SCHEDULE_PATH}/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=>"");
      throw new Error(`PUT scheduled ${res.status} ${txt}`);
    }
    const j = await res.json().catch(()=>null);
    console.log(`[SCHEDULE] marked sent id=${id}`);
    return j;
  } catch (e) {
    console.error("[SCHEDULE] markScheduledMessageSent error:", e.message || e);
    return null;
  }
}

function normalizeSendTime(sendTime) {
  if (!sendTime) return null;
  const s = String(sendTime).trim();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = m[1].padStart(2, "0");
  const mm = m[2];
  return `${hh}:${mm}`;
}

function isAllowedToday(record, nowDate) {
  if (!record) return true;
  const raw = record.daysOfWeek ?? record.daysOfWeek?.toString?.() ?? null;
  if (!raw) return true;
  let arr = [];
  if (Array.isArray(raw)) arr = raw.map(Number);
  else if (typeof raw === "string") arr = raw.split(",").map(s=>Number(s.trim())).filter(n=>!Number.isNaN(n));
  if (!arr.length) return true;
  const jsDow = nowDate.getDay(); // 0 Sun - 6 Sat
  const alt = jsDow === 0 ? 7 : jsDow; // 1-7
  return arr.includes(jsDow) || arr.includes(alt);
}

function schedulePollingJob() {
  const CRON_EXPR = process.env.SCHEDULE_POLL_CRON || "* * * * *"; // every minute
  const TZ = process.env.TZ || "Asia/Ho_Chi_Minh";

  try {
    cron.schedule(CRON_EXPR, async () => {
      try {
        // refresh KB
        KB.refresh();

        // compute local time in TZ
        const now = new Date();
        const s = now.toLocaleString("sv-SE", { timeZone: TZ });
        const localNow = new Date(s.replace(" ", "T"));
        const hhmm = localNow.toTimeString().slice(0,5);
        console.log(`[SCHEDULE] checking scheduled messages at ${hhmm} ${TZ}`);

        const messages = await fetchScheduledMessages(1, 200);
        if (!messages || !messages.length) return;

        const subs = await loadSubscribers();
        if (!subs || !subs.length) {
          console.log("[SCHEDULE] No subscribers to send to.");
        }

        for (const rec of messages) {
          try {
            const recSendTime = normalizeSendTime(rec.sendTime || rec.send_time || rec.sendTimeString);
            if (!recSendTime) continue;
            if (recSendTime !== hhmm) continue;
            if (!isAllowedToday(rec, localNow)) continue;

            // skip if lastSentAt is same minute (prevent duplicate)
            if (rec.lastSentAt) {
              try {
                const last = new Date(rec.lastSentAt);
                const lastLocal = new Date(last.toLocaleString("sv-SE", { timeZone: TZ }).replace(" ", "T"));
                const lastHHMM = lastLocal.toTimeString().slice(0,5);
                if (lastHHMM === hhmm) {
                  console.log(`[SCHEDULE] skip id=${rec.id} already sent at ${lastHHMM}`);
                  continue;
                }
              } catch(e){}
            }

            // prepare message: if rec.message present use it; else if rec.topicId fetch QA
            let messageText = rec.message || rec.msg || rec.content || "";
            if ((!messageText || String(messageText).trim()==="") && rec.topicId) {
              const qas = await fetchQaByTopic(rec.topicId, 1, 5);
              if (qas && qas.length) {
                // choose best: prefer first non-empty message/answer field
                const first = qas.find(x => x.message || x.answer || x.answerText || x.response) || qas[0];
                messageText = first.message || first.answer || first.answerText || first.response || "";
              }
            }
            if (!messageText) {
              console.log(`[SCHEDULE] id=${rec.id} no message to send (skip)`);
              // still mark? skip marking so admin can fix record
              continue;
            }

            const finalText = withAutoPrefix(messageText);

            // send to subscribers
            let sentCount = 0, failedCount = 0;
            if (subs && subs.length) {
              for (const uid of subs) {
                try {
                  const r = await safeSendText(uid, finalText);
                  if (r && r.error === 0) sentCount++; else failedCount++;
                  await new Promise(r=>setTimeout(r, 120));
                } catch (e) {
                  failedCount++;
                }
              }
            }

            console.log(`[SCHEDULE] id=${rec.id} sendTime=${recSendTime} => sent=${sentCount} failed=${failedCount}`);

            // mark record as sent
            await markScheduledMessageSent(rec);

          } catch (e) {
            console.error("[SCHEDULE] record processing error:", e.message || e);
          }
        }
      } catch (e) {
        console.error("[SCHEDULE] cron top error:", e.message || e);
      }
    }, { timezone: TZ });
    console.log(`[SCHEDULE] Polling job scheduled "${CRON_EXPR}" TZ=${process.env.TZ || "system"}`);
  } catch (e) {
    console.error("[SCHEDULE] cannot schedule polling job:", e.message || e);
  }
}

// start schedule polling
schedulePollingJob();

// ----------------- Webhook -----------------
app.post("/webhook", async (req, res) => {
  try {
    await KB.refresh();
    const event = req.body || {};
    const { userId, text, event_name } = extractIncoming(event);
    console.log("[WEBHOOK] incoming:", JSON.stringify({ event_name, userId, text }));

    if (userId && (event_name === "user_follow" || event_name === "user_send_text")) {
      await addSubscriber(userId);
    }

    if (event_name !== "user_send_text") {
      return res.status(200).send("ok");
    }
    if (!userId || !text) return res.status(200).send("ignored");

    if (isThanksOrOk(text)) {
      const ack = "Cảm ơn bạn đã quan tâm, theo dõi và sử dụng dịch vụ của công ty JW Kim";
      const finalMsg = withAutoPrefix(ack);
      const resp = await safeSendText(userId, finalMsg);
      console.log("[WEBHOOK] thanks/ok resp:", resp);
      return res.status(200).send("ok");
    }

    let reply = tryCompanyInfoAnswer(text);
    if (!reply) reply = tryKbAnswer(text);

    if (!reply) {
      try {
        const sys = [
          "Bạn là trợ lý ngắn gọn, trả lời lịch sự, không quá 4 câu.",
          companyInfo?.name ? `Tên công ty: ${companyInfo.name}` : "",
          companyInfo?.hotline ? `Hotline: ${companyInfo.hotline}` : "",
          companyInfo?.email ? `Email: ${companyInfo.email}` : "",
        ].filter(Boolean).join("\n");
        reply = await generateReply([], text, { system: sys });
      } catch (e) {
        console.error("[Gemini] error:", e.message || e);
        reply = "Xin lỗi, hiện mình chưa có thông tin đó. Bạn có thể hỏi về *tên công ty, địa chỉ, giờ làm, liên hệ, chính sách bảo hành…*";
      }
    }

    const finalMsg = withAutoPrefix(reply);
    const resp = await safeSendText(userId, finalMsg);
    console.log("[WEBHOOK] sendText resp:", resp);
    res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e);
    res.status(200).send("ok");
  }
});

// ----------------- Broadcast (hourly) -----------------
const CRON_EXPR = process.env.BROADCAST_CRON || "0 * * * *";
const CRON_TZ = process.env.BROADCAST_TZ || "Asia/Ho_Chi_Minh";
const HOURLY_TEXTS = (process.env.BROADCAST_TEXTS && (() => {
  try { return JSON.parse(process.env.BROADCAST_TEXTS); } catch { return null; }
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
  let sent = 0, failed = 0;
  for (const uid of list) {
    try {
      const r = await sendText(accessToken, uid, payload);
      if (r?.error === 0) sent++; else failed++;
      await new Promise(r => setTimeout(r, 120));
    } catch {
      failed++;
    }
  }
  console.log(`[BROADCAST] Done. total=${list.length}, sent=${sent}, failed=${failed}`);
  return { total: list.length, sent, failed };
}

try {
  console.log(`[CRON] schedule: ${CRON_EXPR} TZ: ${CRON_TZ}`);
  cron.schedule(CRON_EXPR, async () => {
    const idx = hourIndex();
    const text =
      (Array.isArray(HOURLY_TEXTS) && HOURLY_TEXTS[idx]) ||
      process.env.BROADCAST_TEXT ||
      "🔔 Thông báo từ OA.";
    await broadcastOnce(text);
  }, { timezone: CRON_TZ });
} catch (e) {
  console.warn("[CRON] cannot schedule:", e.message || e);
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
    const result = await broadcastOnce(text);
    res.json({ text: withAutoPrefix(text), ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------- Start -----------------
const port = process.env.PORT || 3000;
console.log("Gemini key prefix:", (process.env.GOOGLE_API_KEY || "").slice(0, 4));
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
