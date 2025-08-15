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
const __dirname = path.dirname(__filename);
const app = express();
app.use(bodyParser.json());

// --- Serve static at ROOT (Zalo cần truy cập trực tiếp /<verifier>.html) ---
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));         // https://host/<file>
app.use('/verify', express.static(publicDir)); // tùy chọn

// Tạo route rõ ràng cho file xác thực theo ENV (để “chắc ăn”)
const VERIFY_FILENAME = process.env.ZALO_VERIFY_FILENAME || '';
const VERIFY_CONTENT = process.env.ZALO_VERIFY_CONTENT || '';
if (VERIFY_FILENAME) {
  const verifyPath = '/' + VERIFY_FILENAME.replace(/^\//, '');
  app.get(verifyPath, (req, res) => {
    if (VERIFY_CONTENT) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(VERIFY_CONTENT); // trả đúng chuỗi nếu cần
    }
    const fileOnDisk = path.join(publicDir, VERIFY_FILENAME);
    if (fs.existsSync(fileOnDisk)) return res.sendFile(fileOnDisk);
    return res.status(404).send('Verifier file not found on server.');
  });
}

// Healthcheck
app.get('/health', (_req, res) => res.status(200).send('OK'));

// --- Webhook nhận message từ OA ---
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body || {};
    const userId =
      event?.sender?.user_id ||
      event?.user?.user_id ||
      event?.recipient?.user_id ||
      null;

    const text =
      event?.message?.text ||
      event?.message?.content?.text ||
      event?.text ||
      null;

    if (!userId || !text) return res.status(200).send('ignored');

    const history = []; // TODO: lưu/đọc lịch sử nếu cần
    const reply = await generateReply(history, text);
    const accessToken = await ensureAccessToken();
    await sendText(accessToken, userId, reply);
    res.status(200).send('ok');
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).send('error');
  }
});

// --- OAuth callback (nếu dùng) ---
app.get('/oauth/callback', (req, res) => {
  const code = req.query.code || '';
  res.send(`
    <html><body>
      <h3>OAuth callback</h3>
      <p>Code: ${code}</p>
    </body></html>
  `);
});

// --- Webhook verify token (optional) ---
app.get('/webhook', (req, res) => {
  if (req.query?.verify_token === process.env.VERIFY_TOKEN) return res.send('verified');
  if (req.query?.challenge) return res.send(req.query.challenge);
  res.send('ok');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
