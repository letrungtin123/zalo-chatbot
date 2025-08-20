// gemini.js
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GOOGLE_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/**
 * kb: mảng {title, short} — đã rút gọn từ knowledge.js
 */
export async function generateReply(history, userText, companyInfo, kb = []) {
  const sys = [
    "Bạn là trợ lý Zalo OA của doanh nghiệp.",
    "Chỉ trả lời dựa trên thông tin đã cho (companyInfo + knowledge).",
    "Nếu không chắc, hãy nói bạn không có đủ dữ liệu và hướng dẫn liên hệ hotline.",
  ].join("\n");

  // ghép knowledge làm context
  const kbBlock = kb.length
    ? kb
        .map(
          (d, i) =>
            `# Tài liệu ${i + 1}: ${d.title || "Không tiêu đề"}\n${d.short}`
        )
        .join("\n\n")
    : "";

  const companyBlock = companyInfo
    ? `# Hồ sơ công ty\nTên: ${companyInfo.name || ""}\nĐịa chỉ: ${
        companyInfo.address || ""
      }\nHotline: ${companyInfo.phone || ""}\nWebsite: ${
        companyInfo.website || ""
      }`
    : "";

  const prompt = [
    sys,
    companyBlock,
    kbBlock ? `# Tri thức từ API\n${kbBlock}` : "",
    `# Câu hỏi của khách: ${userText}`,
    "Yêu cầu: Trả lời ngắn gọn, dễ hiểu, giữ định dạng danh sách khi cần.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const resp = await model.generateContent([{ role: "user", parts: [{ text: prompt }] }]);
  const out = resp?.response?.text?.() || resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, hiện chưa có thông tin phù hợp.";
  return out.trim();
}
