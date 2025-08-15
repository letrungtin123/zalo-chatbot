import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

const API_KEY = process.env.GOOGLE_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

if (!API_KEY) console.warn('⚠️ Missing GOOGLE_API_KEY in .env');

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

export async function generateReply(history, userText) {
  // history: [{role:'user'|'assistant', content:'...'}]
  const sys = 'Bạn là trợ lý thân thiện, trả lời ngắn gọn, tiếng Việt, lịch sự.';
  const parts = [
    { text: sys },
    ...history.map(m => ({ text: `${m.role.toUpperCase()}: ${m.content}` })),
    { text: `USER: ${userText}` }
  ];
  const res = await model.generateContent({ contents: [{ role: 'user', parts }] });
  const out = res?.response?.text() || 'Xin lỗi, mình đang bị quá tải.';
  return out.trim();
}
