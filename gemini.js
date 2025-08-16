// gemini.js
import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

const API_KEY    = process.env.GOOGLE_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

// log prefix để nhìn trong Render logs (phải là 'AIza')
console.log('Gemini key prefix:', (API_KEY || '').slice(0,4));

let model = null;
if (!API_KEY) {
  console.warn('⚠️ Missing GOOGLE_API_KEY in .env');
} else {
  const genAI = new GoogleGenerativeAI(API_KEY);
  model = genAI.getGenerativeModel({ model: MODEL_NAME });
}

export async function generateReply(history, userText) {
  const sys = 'Bạn là trợ lý thân thiện, trả lời ngắn gọn, tiếng Việt, lịch sự.';
  const conversation = [
    sys,
    ...history.map(m => `${m.role.toUpperCase()}: ${m.content}`),
    `USER: ${userText}`
  ].join('\n\n');

  if (!model) {
    return `Mình chưa cấu hình API key nên trả lời ngắn: ${userText}`;
  }

  try {
    const res = await model.generateContent(conversation);
    const out = res?.response?.text() || 'Xin lỗi, mình đang bị quá tải.';
    return out.trim();
  } catch (e) {
    console.error('Gemini error:', e);
    return `Xin lỗi, AI đang lỗi. Mình trả lời ngắn: ${userText}`;
  }
}
