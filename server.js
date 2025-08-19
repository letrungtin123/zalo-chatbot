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
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body || {};
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

    // Nếu webhook test/hoặc event ko có text -> OK ngay để Zalo “Kiểm tra” không 500
    if (!userId || !text) {
      return res.status(200).send("ok");
    }

    // ... ở đây mới gọi AI và ensureAccessToken
    const reply = await generateReply([], text);

    const accessToken = await ensureAccessToken(); // <-- hàm mới
    const sendResp = await sendText(accessToken, userId, reply);

    console.log("[WEBHOOK] sendText resp:", sendResp);
    res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e);
    // Trả 200 để Zalo không fail webhook (bạn có thể đổi thành 500 tuỳ nhu cầu)
    res.status(200).send("ok");
  }
});


const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
