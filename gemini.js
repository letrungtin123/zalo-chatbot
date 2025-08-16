// gemini.js
import 'dotenv/config';
import axios from 'axios';

const API_KEY = (process.env.GOOGLE_API_KEY || '').trim();
const MODEL   = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// In ra vài thông tin gỡ lỗi (ẩn bớt key)
console.log(`Gemini key prefix: ${API_KEY ? API_KEY.slice(0,4) : '(none)'}*** len=${API_KEY.length}`);

export async function generateReply(history, userText) {
  const sys = 'Bạn là trợ lý thân thiện, trả lời ngắn gọn, tiếng Việt, lịch sự.';
  const prompt = [
    { role: 'user',    content: sys },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user',    content: userText }
  ]
  // REST body theo schema của Generative Language API
  const body = {
    contents: [
      {
        parts: [{ text: prompt.map(p => `${p.role.toUpperCase()}: ${p.content}`).join('\n\n') }]
      }
    ]
  };

  try {
    const { data } = await axios.post(ENDPOINT, body, {
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY,       // QUAN TRỌNG: header đúng tên
      },
      timeout: 15000,
    });

    // Đọc text
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text
      || data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n')
      || 'Xin lỗi, mình chưa hiểu.';
    return text.trim();
  } catch (e) {
    // Log chi tiết để dò
    console.error('Gemini error:', e?.response?.status, e?.response?.statusText, e?.response?.data || e.message);
    return 'Xin lỗi, có lỗi khi gọi Gemini.';
  }
}

// Route test nhanh từ server
export async function testGeminiPing() {
  return await generateReply([], 'ping');
}
