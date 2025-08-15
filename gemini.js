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
  const conversation = [
    sys,
    ...history.map(m => `${m.role.toUpperCase()}: ${m.content}`),
    `USER: ${userText}`
  ].join('\n\n');

  try {
    const res = await model.generateContent(conversation);
    const out = res?.response?.text() || 'Xin lỗi, mình đang bị quá tải.';
    return out.trim();
  } catch (e) {
    console.error('Gemini error:', e);
    return 'Xin lỗi, có lỗi xảy ra khi tạo câu trả lời.';
  }
}
