// gemini.js
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const RAW = process.env.GOOGLE_API_KEY || "";
// Xóa khoảng trắng/ngoặc nếu lỡ dán kèm
const API_KEY = RAW.trim().replace(/^['"]|['"]$/g, "");
if (!API_KEY) console.warn("❗ GOOGLE_API_KEY is empty");

const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

export async function generateReply(history, userText) {
  const sys = "Bạn là trợ lý thân thiện, trả lời ngắn gọn, tiếng Việt, lịch sự.";
  const convo = [
    sys,
    ...history.map((m) => `${m.role.toUpperCase()}: ${m.content}`),
    `USER: ${userText}`,
  ].join("\n\n");

  try {
    const res = await model.generateContent(convo);
    const out = res?.response?.text() || "Xin lỗi, mình đang bận.";
    return out.trim();
  } catch (e) {
    console.error("Gemini error:", e);
    return "Xin lỗi, có lỗi khi gọi AI.";
  }
}
