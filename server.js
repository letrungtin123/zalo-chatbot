import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import { ensureAccessToken } from './zaloOAuth.js';
import { sendText } from './zaloApi.js';
import { generateReply } from './gemini.js';

const app = express();
app.use(bodyParser.json());

// (Tuỳ chọn) verify chữ ký webhook nếu Zalo gửi header x-zalo-signature
function verifySignature(req) {
  const secret = process.env.ZALO_APP_SECRET_WEBHOOK;
  if (!secret) return true; // bỏ qua nếu chưa cấu hình
  const sig = req.headers['x-zalo-signature'] || req.headers['x-zalo-sig'];
  if (!sig) return true;
  const bodyStr = JSON.stringify(req.body);
  const h = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
  return h === sig;
}

// Webhook verify (nếu Zalo gọi GET)
app.get('/webhook', (req, res) => {
  if (req.query?.verify_token && req.query.verify_token === process.env.VERIFY_TOKEN) {
    return res.status(200).send('verified');
  }
  if (req.query?.challenge) return res.send(req.query.challenge);
  res.send('ok');
});

// Webhook nhận message
app.post('/webhook', async (req, res) => {
  try {
    if (!verifySignature(req)) return res.status(403).send('invalid signature');

    const event = req.body || {};
    // Tuỳ biến theo payload Zalo của bạn:
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

    if (!userId || !text) {
      console.log('Unrecognized webhook shape:', JSON.stringify(event).slice(0,400));
      return res.status(200).send('ignored');
    }

    // (ở demo đơn giản không lưu Redis; bạn có thể tự thêm)
    const history = []; // có thể đọc/ghi vào DB nếu muốn

    // Gọi Gemini
    const reply = await generateReply(history, text);

    // Đảm bảo có access_token (đổi/refresh tự động)
    const accessToken = await ensureAccessToken();

    // Gửi trả qua OA
    await sendText(accessToken, userId, reply);

    res.status(200).send('ok');
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).send('error');
  }
});

// OAuth callback (nếu bạn muốn lấy code tự động)
app.get('/oauth/callback', async (req, res) => {
  // Trang này chỉ hiển thị hướng dẫn — việc đổi code → token bạn dùng script `npm run exchange:code`
  const code = req.query.code || '';
  res.send(`
    <h3>OAuth callback</h3>
    <p>Code nhận được: <code>${code}</code></p>
    <p>Để đổi code sang token và lưu vào <b>tokens.json</b>, chạy:</p>
    <pre>OAUTH_CODE_ONCE=${code} npm run exchange:code</pre>
  `);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
