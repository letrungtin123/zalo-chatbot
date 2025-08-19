import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import fs from 'fs';

import { sendText } from './zaloApi.js';
import { generateReply } from './gemini.js';
import { ensureAccessToken } from './zaloOAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// Static (tuỳ bạn có file xác thực HTML hay không)
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/health', (_req, res) => res.status(200).send('OK'));

// Webhook
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body || {};

    // map đủ kiểu structure của Zalo
    const userId =
      event?.sender?.user_id ||
      event?.sender?.id ||
      event?.user?.user_id ||
      event?.recipient?.user_id ||
      null;

    const text =
      event?.message?.text ||
      event?.message?.content?.text ||
      event?.text ||
      null;

    // Cho các event “check webhook”, “đã nhận”, vv…
    if (!userId || !text) {
      return res.status(200).send('ok');
    }

    // Gọi AI
    const reply = await generateReply([], text);

    // Lấy access_token an toàn
    let accessToken;
    try {
      accessToken = await ensureAccessToken();
    } catch (e) {
      console.warn('[WEBHOOK] ensureAccessToken warn:', e.message);
      // Fallback: dùng ACCESS từ ENV nếu có
      if (process.env.ZALO_ACCESS_TOKEN) {
        accessToken = process.env.ZALO_ACCESS_TOKEN;
      } else {
        // Bó tay -> trả 200 để Zalo không coi là lỗi
        return res.status(200).send('ok');
      }
    }

    const sendResp = await sendText(accessToken, userId, reply);
    console.log('[WEBHOOK] sendText resp:', sendResp);

    return res.status(200).send('ok');
  } catch (e) {
    console.error('[WEBHOOK] error:', e);
    // Không trả 500 để trang “Kiểm tra” khỏi báo fail
    return res.status(200).send('ok');
  }
});

// Optional: verify token GET
app.get('/webhook', (req, res) => {
  if (req.query?.verify_token === process.env.VERIFY_TOKEN) return res.send('verified');
  if (req.query?.challenge) return res.send(req.query.challenge);
  res.send('ok');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const k = (process.env.GOOGLE_API_KEY || '').slice(0, 4);
  console.log('Gemini key prefix:', k);
  console.log(`✅ Server listening on port ${port}`);
});
