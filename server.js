// server.js
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import fs from 'fs';
import cron from 'node-cron';

import { sendText } from './zaloApi.js';
import { generateReply } from './gemini.js';
import { ensureAccessToken } from './zaloOAuth.js';
import { addSubscriber, getSubscribers, countSubscribers } from './subscribersStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// Static (nếu cần xác thực HTML)
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

app.get('/health', (_req, res) => res.status(200).send('OK'));

// Chống gửi lặp theo msg_id (in-memory)
const seenMsgIds = new Set();
function rememberMsgId(id, ttlMs = 5 * 60 * 1000) {
  if (!id) return;
  seenMsgIds.add(id);
  setTimeout(() => seenMsgIds.delete(id), ttlMs).unref?.();
}

// Webhook (chỉ phản hồi user_send_text)
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body || {};
    const eventName = event?.event_name;

    // chỉ xử lý khi là user_send_text
    if (eventName !== 'user_send_text') {
      return res.status(200).send('ok');
    }

    const msgId  = event?.message?.msg_id;
    if (msgId && seenMsgIds.has(msgId)) {
      return res.status(200).send('ok');
    }
    rememberMsgId(msgId);

    const userId = event?.sender?.user_id || event?.sender?.id || null;
    const text   = event?.message?.text || null;

    if (!userId || !text) {
      return res.status(200).send('ok');
    }

    // lưu subscriber
    await addSubscriber(userId);

    // sinh reply
    const reply = await generateReply([], text);

    // access token
    let accessToken = '';
    try {
      accessToken = await ensureAccessToken();
    } catch (e) {
      console.warn('[WEBHOOK] ensureAccessToken warn:', e.message);
      if (process.env.ZALO_ACCESS_TOKEN) {
        accessToken = process.env.ZALO_ACCESS_TOKEN;
      } else {
        return res.status(200).send('ok');
      }
    }

    const resp = await sendText(accessToken, userId, reply);
    console.log('[WEBHOOK] sendText resp:', resp);

    return res.status(200).send('ok');
  } catch (e) {
    console.error('[WEBHOOK] error:', e);
    // Luôn trả 200 để Zalo không đánh lỗi webhook
    return res.status(200).send('ok');
  }
});

// Admin: xem số subscriber
app.get('/admin/subscribers', async (_req, res) => {
  try {
    const list = await getSubscribers();
    res.json({ count: list.length, sample: list.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: bắn broadcast ngay (POST {text})
app.post('/admin/broadcast', async (req, res) => {
  try {
    let body = '';
    req.on('data', chunk => body += chunk);
    await new Promise(r => req.on('end', r));
    const parsed = body ? JSON.parse(body) : {};
    const text = (parsed.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });

    const report = await broadcastToAll(text);
    res.json(report);
  } catch (e) {
    console.error('[ADMIN] broadcast error', e);
    res.status(500).json({ error: e.message });
  }
});

// Broadcast helper
async function broadcastToAll(text) {
  const users = await getSubscribers();
  let accessToken = '';
  try {
    accessToken = await ensureAccessToken();
  } catch (e) {
    console.warn('[BROADCAST] ensureAccessToken warn:', e.message);
    accessToken = process.env.ZALO_ACCESS_TOKEN || '';
  }
  if (!accessToken) throw new Error('No access token');

  const results = { ok: 0, fail: 0, errors: [] };

  // Gửi tuần tự để tránh rate-limit
  for (const uid of users) {
    try {
      const r = await sendText(accessToken, uid, text);
      if (r?.error === 0) results.ok++;
      else {
        results.fail++;
        results.errors.push({ user_id: uid, resp: r });
      }
    } catch (e) {
      results.fail++;
      results.errors.push({ user_id: uid, error: e.message });
    }
    // nho nhỏ để dịu rate-limit
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('[BROADCAST] done:', results);
  return results;
}

// Cron: gửi theo lịch (nếu cấu hình)
const CRON = (process.env.BROADCAST_CRON || '').trim();         // ví dụ: 0 9 * * *  (9:00 hằng ngày)
const TZONE = process.env.BROADCAST_TZ || 'Asia/Ho_Chi_Minh';
const BMSG = (process.env.BROADCAST_MESSAGE || '').trim();

if (CRON && BMSG) {
  console.log('[CRON] schedule:', CRON, 'TZ:', TZONE);
  cron.schedule(CRON, async () => {
    try {
      await broadcastToAll(BMSG);
    } catch (e) {
      console.error('[CRON] broadcast error:', e);
    }
  }, { timezone: TZONE });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Gemini key prefix:', (process.env.GOOGLE_API_KEY || '').slice(0, 4));
  console.log(`✅ Server listening on port ${port}`);
});
