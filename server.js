// server.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { sendText } from './zaloApi.js';
import { generateReply } from './gemini.js';

// ----------------- Setup -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);
app.use(bodyParser.json({ limit: '1mb' }));

// ----------------- Static & Verify file -----------------
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));            // GET https://host/<file>
app.use('/verify', express.static(publicDir)); // tuỳ chọn: GET /verify/<file>

const VERIFY_FILENAME = process.env.ZALO_VERIFY_FILENAME || '';
const VERIFY_CONTENT  = process.env.ZALO_VERIFY_CONTENT  || '';
if (VERIFY_FILENAME) {
  const verifyPath = '/' + VERIFY_FILENAME.replace(/^\//, '');
  app.get(verifyPath, (_req, res) => {
    if (VERIFY_CONTENT) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(VERIFY_CONTENT);
    }
    const fileOnDisk = path.join(publicDir, VERIFY_FILENAME);
    if (fs.existsSync(fileOnDisk)) return res.sendFile(fileOnDisk);
    return res.status(404).send('Verifier file not found on server.');
  });
}

// ----------------- Health & Root (Render cần 200) -----------------
app.get('/', (_req, res) => res.status(200).send('OK root'));
app.get('/health', (_req, res) => res.status(200).send('OK'));

// ----------------- Webhook verify (GET) -----------------
app.get('/webhook', (req, res) => {
  if (req.query?.verify_token === process.env.VERIFY_TOKEN) return res.send('verified');
  if (req.query?.challenge) return res.send(req.query.challenge);
  res.send('ok');
});

// ----------------- Webhook nhận tin (POST) -----------------
app.post('/webhook', (req, res) => {
  // Ack ngay để Zalo không timeout
  res.status(200).send('ok');

  // Xử lý nền
  (async () => {
    try {
      const event = req.body || {};

      // Lấy userId: hỗ trợ cả id & user_id ở nhiều nhánh
      const userId =
        event?.sender?.user_id || event?.sender?.id ||
        event?.user?.user_id   || event?.user?.id   ||
        (event?.recipient?.user_id && event?.event_name?.includes('oa_send') ? event?.recipient?.user_id : null) ||
        null;

      // Lấy text
      const text =
        event?.message?.text ||
        event?.message?.content?.text ||
        event?.text ||
        null;

      console.log('[WEBHOOK] incoming:', JSON.stringify({ userId, text, raw: event }));

      if (!userId || !text) {
        console.log('[WEBHOOK] ignored (missing userId/text)');
        return;
      }

      // Gọi LLM tạo trả lời
      let reply = 'Xin chào!';
      try {
        const history = []; // có thể lưu lịch sử nếu cần
        reply = (await generateReply(history, text)) || reply;
      } catch (e) {
        console.error('[WEBHOOK] generateReply error:', e?.message || e);
      }

      // Lấy access_token (chuẩn v4 trong zaloOauth.js)
      const accessToken = await ensureAccessToken();

      // Gửi trả lời về Zalo
      const sendResp = await sendText(accessToken, userId, reply);
      console.log('[WEBHOOK] sendText resp:', sendResp);
    } catch (e) {
      console.error('[WEBHOOK] error:', e?.response?.data || e.message || e);
    }
  })();
});

// ----------------- OAuth callback (để copy code) -----------------
app.get('/oauth/callback', (req, res) => {
  const code = req.query.code || '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<h3>OAuth callback</h3><p>Code: ${code}</p>`);
});

// ----------------- 404 fallback -----------------
app.use((req, res) => res.status(404).send('Not Found'));

// ----------------- Start -----------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});

// ----------------- Safety logs -----------------
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
