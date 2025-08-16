// gemini.js
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY = process.env.GOOGLE_API_KEY || "";
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-1.5-flash";

let model = null;
if (API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(API_KEY);
    model = genAI.getGenerativeModel({ model: MODEL_NAME });
    console.log("Gemini key prefix:", API_KEY.slice(0, 4));
  } catch (e) {
    console.error("Gemini init error:", e);
  }
}

function normalize(str = "") {
  return str
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

function faqLookup(question, company) {
  try {
    const qn = normalize(question);
    const faqs = Array.isArray(company?.faqs) ? company.faqs : [];
    for (const f of faqs) {
      const keys = Array.isArray(f.q) ? f.q : [f.q].filter(Boolean);
      if (keys.some((k) => qn.includes(normalize(k)))) {
        return f.a;
      }
    }
  } catch {}
  return null;
}

export async function generateReply(history, userText, company = {}) {
  // 1) ưu tiên trả lời theo FAQ
  const faq = faqLookup(userText, company);
  if (faq) return faq;

  // 2) nếu không có Gemini key, trả lời fallback tĩnh
  if (!model) {
    return "Xin lỗi, hiện mình chỉ trả lời được những câu hỏi cơ bản. Vui lòng liên hệ CSKH để được hỗ trợ nhanh hơn.";
  }

  const sys = [
    "Bạn là trợ lý CSKH của một doanh nghiệp. Trả lời ngắn gọn, lịch sự, tiếng Việt.",
    "Nếu câu hỏi nằm trong profile (tên, hotline, email, địa chỉ, giờ làm việc, dịch vụ, chính sách), ưu tiên dùng profile.",
    "Nếu không chắc, hãy xin thêm thông tin hoặc hướng dẫn liên hệ CSKH.",
  ].join("\n");

  const profile = JSON.stringify(
    {
      name: company.name || company.legal_name,
      hotline: company.hotline,
      email: company.email,
      address: company.address,
      open_hours: company.open_hours,
      website: company.website,
      services: company.services,
      policies: company.policies,
    },
    null,
    2
  );

  const conversation = [
    `HỒ SƠ DOANH NGHIỆP:\n${profile}`,
    sys,
    ...history.map((m) => `${m.role.toUpperCase()}: ${m.content}`),
    `USER: ${userText}`,
  ].join("\n\n");

  try {
    const res = await model.generateContent(conversation);
    const out = res?.response?.text() || "";
    return out.trim() || "Mình chưa chắc câu hỏi này, bạn cho mình biết thêm chi tiết nhé.";
  } catch (e) {
    console.error("Gemini error:", e);
    return "Xin lỗi, hệ thống AI đang bận. Bạn vui lòng thử lại sau hoặc liên hệ CSKH giúp mình nhé.";
  }
}
