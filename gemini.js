// gemini.js
import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';

const API_KEY    = process.env.GOOGLE_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

function loadCompanyInfo() {
  try {
    const raw = fs.readFileSync('./companyInfo.json', 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildSystemPrompt(ci) {
  const base =
    'Bạn là trợ lý thân thiện, trả lời ngắn gọn, tiếng Việt, lịch sự. ' +
    'Nếu câu hỏi nằm ngoài phạm vi thông tin công ty, hãy trả lời chung và mời liên hệ hotline/email.';

  if (!ci) return base;

  const faqText = Array.isArray(ci.faq)
    ? ci.faq.map((x,i) => `- Q: ${x.q}\n  A: ${x.a}`).join('\n')
    : '';

  return [
    base,
    'Dưới đây là thông tin doanh nghiệp:',
    `- Tên: ${ci.name || ''}`,
    `- Slogan: ${ci.slogan || ''}`,
    `- Địa chỉ: ${ci.address || ''}`,
    `- Hotline: ${ci.hotline || ''}`,
    `- Email: ${ci.email || ''}`,
    `- Website: ${ci.website || ''}`,
    `- Giờ làm việc: ${ci.working_hours || ''}`,
    `- Dịch vụ: ${(ci.services || []).join(', ')}`,
    faqText ? `FAQ:\n${faqText}` : ''
  ].join('\n');
}

function ruleBased(ci, userText) {
  if (!ci) return null;
  const t = (userText || '').toLowerCase();

  const pick = (k) => ci[k] ? String(ci[k]) : null;

  if (t.includes('tên công ty') || t.includes('tên doanh nghiệp')) {
    return `Công ty: ${pick('name') || 'chưa cập nhật'}.`;
  }
  if (t.includes('địa chỉ') || t.includes('ở đâu')) {
    return `Địa chỉ: ${pick('address') || 'chưa cập nhật'}.`;
  }
  if (t.includes('hotline') || t.includes('sđt') || t.includes('sdt') || t.includes('điện thoại')) {
    return `Hotline: ${pick('hotline') || 'chưa cập nhật'}.`;
  }
  if (t.includes('giờ làm') || t.includes('giờ mở cửa')) {
    return `Giờ làm việc: ${pick('working_hours') || 'chưa cập nhật'}.`;
  }
  if (t.includes('website') || t.includes('web') || t.includes('trang web')) {
    return `Website: ${pick('website') || 'chưa cập nhật'}.`;
  }
  return null;
}

export async function generateReply(history, userText) {
  const ci   = loadCompanyInfo();
  const sys  = buildSystemPrompt(ci);
  const conv = [
    sys,
    ...history.map(m => `${m.role.toUpperCase()}: ${m.content}`),
    `USER: ${userText}`
  ].join('\n\n');

  try {
    const res = await model.generateContent(conv);
    const out = res?.response?.text() || '';
    const trimmed = out.trim();
    if (trimmed) return trimmed;
  } catch (e) {
    console.error('Gemini error:', e);
  }

  // Fallback rule-based theo companyInfo
  const rb = ruleBased(ci, userText);
  if (rb) return rb;

  // Fallback cuối
  const hotline = ci?.hotline ? ` Hotline: ${ci.hotline}.` : '';
  const email   = ci?.email   ? ` Email: ${ci.email}.`     : '';
  return `Mình chưa đủ thông tin để trả lời. Bạn có thể cho biết cụ thể hơn?${hotline}${email}`;
}
