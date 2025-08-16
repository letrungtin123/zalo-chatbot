// gemini.js
import "dotenv/config";
import axios from "axios";

const RAW = process.env.GOOGLE_API_KEY || "";
// loại bỏ khoảng trắng + ngoặc nếu lỡ dán kèm
const API_KEY = RAW.trim().replace(/^['"]|['"]$/g, "");
if (!API_KEY) console.warn("❗ GOOGLE_API_KEY is empty");

const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

/**
 * Gọi Generative Language API trực tiếp bằng header x-goog-api-key
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callGeminiDirect(prompt) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
  };

  const { data } = await axios.post(ENDPOINT, body, {
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": API_KEY, // chìa khóa nằm ở HEADER
    },
    timeout: 15000,
  });

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ||
    "";
  return (text || "").trim();
}

/**
 * API dự phòng: gọi bằng query param ?key= (để so sánh)
 */
async function callGeminiQueryParam(prompt) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
  };

  const url = `${ENDPOINT}?key=${encodeURIComponent(API_KEY)}`;
  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ||
    "";
  return (text || "").trim();
}

export async function generateReply(history, userText) {
  const sys = "Bạn là trợ lý thân thiện, trả lời ngắn gọn, tiếng Việt, lịch sự.";
  const convo = [
    sys,
    ...history.map(m => `${m.role.toUpperCase()}: ${m.content}`),
    `USER: ${userText}`,
  ].join("\n\n");

  // Thử cách 1 (header) trước
  try {
    const out = await callGeminiDirect(convo);
    if (out) return out;
  } catch (e) {
    console.error("Gemini (header) error:", e?.response?.data || e.message || e);
  }

  // Fallback cách 2 (query) để so sánh
  try {
    const out2 = await callGeminiQueryParam(convo);
    if (out2) return out2;
  } catch (e) {
    console.error("Gemini (query) error:", e?.response?.data || e.message || e);
  }

  return "Xin lỗi, AI đang lỗi.";
}

// Xuất thêm 2 hàm debug để tạo endpoint test
export const _debug_callGeminiDirect = callGeminiDirect;
export const _debug_callGeminiQuery  = callGeminiQueryParam;
