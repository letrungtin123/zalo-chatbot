// gemini.js
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { answerFromFAQ, buildCompanySystemPrompt } from "./companyInfo.js";

const API_KEY = process.env.GOOGLE_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-1.5-flash";

if (!API_KEY) console.warn("⚠️ Missing GOOGLE_API_KEY in .env");

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

/**
 * history: [{role:'user'|'assistant', content:'...'}]
 * companyInfo: object từ companyInfo.js
 */
export async function generateReply(history, userText, companyInfo) {
  // 0) Thử FAQ trước cho nhanh/ổn định
  const faq = answerFromFAQ(userText, companyInfo);
  if (faq) return faq;

  // 1) Lập system prompt chứa hồ sơ doanh nghiệp
  const sys = buildCompanySystemPrompt(companyInfo);

  // 2) Chuỗi hội thoại “đơn giản mà chắc”
  const conversation = [
    sys,
    ...(history || []).map(m => `${m.role.toUpperCase()}: ${m.content}`),
    `USER: ${userText}`,
    "ASSISTANT:"
  ].join("\n\n");

  try {
    const res = await model.generateContent(conversation);
    const out = res?.response?.text() || "Xin lỗi, mình đang bận. Bạn vui lòng thử lại sau nhé!";
    return out.trim();
  } catch (e) {
    console.error("Gemini error:", e);
    // 3) Fallback cuối: trả lời thủ công tối thiểu từ hồ sơ
    return [
      companyInfo.legal_name || companyInfo.name
        ? `Bên mình là ${companyInfo.legal_name || companyInfo.name}.`
        : "Xin lỗi, hiện mình chưa có thông tin hiển thị.",
      companyInfo.address ? `Địa chỉ: ${companyInfo.address}.` : "",
      companyInfo.hotline ? `Hotline: ${companyInfo.hotline}.` : "",
      companyInfo.website ? `Website: ${companyInfo.website}.` : ""
    ].filter(Boolean).join(" ");
  }
}
