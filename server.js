// server.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { sendText } from './zaloApi.js';
import { generateReply } from './gemini.js';
import { ensureAccessToken } from './zaloOAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.set('trust proxy', true);
app.use(bodyParser.json({ limit: '1mb' }));

// Serve static (nếu bạn có file verify)
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck
app.get('/health', (_req, res) => res.status(200).send('OK'));

// GET webhook: luôn 200 (Zalo có thể ping)
app.get('/webhook', (req, res) => {
  return res.status(200).send('ok');
});

// POST webhook: chỉ xử lý khi là user_send_text + có userId & text
app.post('/webhook', async (req, res) => {
  try {
    const ev = req.body || {};
    const eventName = ev?.event_name || '';

    // userId và text ở nhiều vị trí khác nhau
    const userId =
      ev?.sender?.id ||
      ev?.sender?.user_id ||
      ev?.recipient?.user_id ||
      null;

    const text =
      ev?.message?.text ||
      ev?.message?.content?.text ||
      ev?.text ||
      null;

    // 1) Không phải user_send_text -> acknowledge 200
    if (eventName && eventName !== 'user_send_text') {
      console.log('[WEBHOOK] non-text event -> 200', eventName);
      return res.status(200).send('ok');
    }

    // 2) Thiếu userId/text -> acknowledge 200
    if (!userId || !text) {
      console.log('[WEBHOOK] missing userId/text -> 200', { userId, text });
      return res.status(200).send('ok');
    }

    // 3) Tạo reply từ Gemini (nếu lỗi vẫn tiếp tục ack 200)
    let reply = 'Xin lỗi, mình đang bận chút. Bạn thử nhắn lại sau nhé!';
    try {
      reply = await generateReply([], text);
    } catch (e) {
      console.error('Gemini error:', e);
    }

    // 4) Lấy access token (nếu lỗi, vẫn ack 200)
    let accessToken;
    try {
      accessToken = await ensureAccessToken();
    } catch (e) {
      console.error('[WEBHOOK] ensureAccessToken error', e);
      return res.status(200).send('ok');
    }

    // 5) Gửi trả lời (nếu lỗi, vẫn ack 200)
    try {
      const resp = await sendText(accessToken, userId, reply);
      console.log('[WEBHOOK] sendText resp:', resp);
    } catch (e) {
      console.error('[WEBHOOK] sendText error', e);
    }

    return res.status(200).send('ok');
  } catch (e) {
    console.error('[WEBHOOK] fatal', e);
    // QUAN TRỌNG: vẫn trả 200 để Zalo không báo fail
    return res.status(200).send('ok');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
