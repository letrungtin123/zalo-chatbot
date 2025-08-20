// gemini.js
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY = process.env.GOOGLE_API_KEY || "";
const MODEL   = process.env.GOOGLE_MODEL || "gemini-1.5-flash";

if (!API_KEY) {
  console.warn("⚠️ Missing GOOGLE_API_KEY");
}

const genAI = new GoogleGenerativeAI(API_KEY);

/**
 * Tạo system prompt từ thông tin công ty + tri thức (kbDocs)
 */
function buildSystem(companyInfo, kbDocs = []) {
  let sys = `Bạn là trợ lý CSKH của OA trên Zalo. Trả lời ngắn gọn, lịch sự, dùng tiếng Việt.
- Nếu có thông tin trong tri thức, hãy ưu tiên dùng nó.
- Nếu không chắc, xin phép người dùng cho biết thêm chi tiết hoặc để lại số điện thoại.

`;
  if (companyInfo) {
    sys += `Thông tin doanh nghiệp:
- Tên: ${companyInfo.companyName || ""}
- Địa chỉ: ${companyInfo.address || ""}
- Điện thoại: ${companyInfo.phone || ""}
- Email: ${companyInfo.email || ""}

`;
  }
  if (kbDocs?.length) {
    sys += `Tri thức nội bộ (tóm tắt):\n`;
    for (const d of kbDocs.slice(0, 3)) {
      const snippet = (d.contentText || "").slice(0, 600);
      sys += `• ${d.title}: ${snippet}\n`;
    }
    sys += "\n";
  }
  return sys;
}

/**
 * history không dùng đến ở bản đơn giản (để trống [] cũng ok)
 * userText: câu hỏi của người dùng
 * companyInfo: thông tin công ty (để đưa vào system)
 * kbDocs: top K tài liệu tìm được từ API /Introduce/list (để làm ngữ cảnh)
 */
export async function generateReply(history = [], userText = "", companyInfo = null, kbDocs = []) {
  const systemInstruction = buildSystem(companyInfo, kbDocs);

  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction,
  });

  // Truyền MỘT CHUỖI prompt -> SDK sẽ tạo JSON đúng (tránh lỗi role/parts)
  const prompt = `Câu hỏi của khách: """${userText}"""\nHãy trả lời hữu ích, nếu có link trong tri thức thì nêu ra.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    return text || "Xin lỗi, hiện mình chưa tạo được câu trả lời. Bạn có thể đặt lại câu hỏi nhé!";
  } catch (e) {
    console.error("Gemini error:", e);
    return "Xin lỗi, hệ thống AI đang bận. Bạn vui lòng hỏi lại sau một chút nhé!";
  }
}
