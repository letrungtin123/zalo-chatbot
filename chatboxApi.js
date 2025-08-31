// chatboxApi.js
import "dotenv/config";

const BASE   = (process.env.CHATBOX_API_BASE || "").replace(/\/+$/, "");
const TOPIC  = process.env.CHATBOX_TOPIC_PATH || "/ChatboxAITopic";
const QA     = process.env.CHATBOX_QA_PATH || "/ChatboxAIQA";
const SCHED  = process.env.CHATBOX_SCHEDULE_PATH || "/ChatboxAIScheduledMessage";

const DEF_HEADERS = { Accept: "application/json" };
const TIMEOUT_MS  = 12000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return Promise.race([
    promise(ac.signal).finally(() => clearTimeout(t)),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms + 50))
  ]);
}

function shapeList(json) {
  // hỗ trợ nhiều kiểu shape trả về: {items}, {data}, {result}, mảng trực tiếp
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.data))  return json.data;
  if (Array.isArray(json.result))return json.result;
  if (json?.pagedItems?.items)   return json.pagedItems.items;
  return [];
}

export async function getTopics() {
  if (!BASE) return [];
  const url = `${BASE}${TOPIC}?page=1&pageSize=50`;
  const json = await withTimeout((signal) =>
    fetch(url, { headers: DEF_HEADERS, signal }).then(r => r.json())
  );
  const list = shapeList(json)
    .map(x => ({
      id: x.id ?? x.topicId ?? x.Id ?? x.TopicId,
      name: x.name ?? x.topicName ?? x.TopicName ?? x.nameTopic ?? "",
    }))
    .filter(x => x.id && x.name);
  return list;
}

export async function getQAByTopic(topicId) {
  if (!BASE) return [];
  const url = `${BASE}${QA}?page=1&pageSize=50&topicId=${encodeURIComponent(topicId)}`;
  const json = await withTimeout((signal) =>
    fetch(url, { headers: DEF_HEADERS, signal }).then(r => r.json())
  );
  const list = shapeList(json)
    .map(x => ({
      id: x.id ?? x.qaId ?? x.Id,
      question: x.question ?? x.title ?? x.contentQuestion ?? x.q ?? "",
      answer: x.answer ?? x.contentAnswer ?? x.a ?? "",
    }))
    .filter(x => x.id && x.question);
  return list;
}

export async function getSchedules() {
  if (!BASE) return [];
  const url = `${BASE}${SCHED}?page=1&pageSize=100`;
  const json = await withTimeout((signal) =>
    fetch(url, { headers: DEF_HEADERS, signal }).then(r => r.json())
  );
  const list = shapeList(json)
    .map(x => ({
      id: x.id ?? x.Id,
      topicId: x.topicId ?? x.TopicId ?? null,
      message: x.message ?? x.Message ?? "",
      // BE của bạn đang lưu "sendTime" dạng "HH:mm"
      sendTime: String(x.sendTime ?? x.SendTime ?? "").slice(0,5),
    }))
    .filter(x => x.message);
  return list;
}
