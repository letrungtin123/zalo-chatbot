// server.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { sendText } from './zaloApi.js';
import { generateReply, testGeminiPing } from './gemini.js';
import * as oauth from './zaloOAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);
app.use(bodyParser.json({ limit: '1mb' }));

// static (nếu cần xác thực file HTML)
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

app.get('/health', (_req, res) => res.status(200).send('OK'));

// ====== DEBUG ======
app.get('/debug/env', (_req, res) => {
  const k = (process.env.GOOGLE_API_KEY || '').trim();
  res.json({
    keyPrefix: k.slice(0,4) + '***',
    keyLen: k.length,
    hasTrailingSpace: (process.env.GOOGLE_API_KEY || '') !== k,
    model: process.env.GEMINI_MODEL,
    appId: process.env.ZALO_APP_ID,
  });
});

app.get('/debug/gemini/ping', async (_req, res) => {
  try {
    const out = await testGeminiPing();
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/debug/gemini/curl', (_req, res) => {
  const key = (process.env.GOOGLE_API_KEY || '').trim();
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const example = `curl -X POST '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H 'x-goog-api-key: ${key}' \\
  -d '{ "contents":[{ "parts":[{ "text":"ping" }] }] }'`;
  res.type('text/plain').send(example);
});

// ====== WEBHOOK ZALO ======
app.post('/webhook', async (req, res) => {
  try {
    const raw = req.body || {};
    const userId =
      raw?.sender?.user_id || raw?.sender?.id ||
      raw?.user?.user_id   || raw?.recipient?.user_id ||
      null;

    const text =
      raw?.message?.text ||
      raw?.message?.content?.text ||
      raw?.text || null;

    console.log('[WEBHOOK] incoming:', JSON.stringify({ userId, text, raw }, null, 0));

    if (!userId || !text) return res.status(200).send('ignored');

    // Gọi Gemini
    const reply = await generateReply([], text);

    // Lấy OA token
    const accessToken = await oauth.ensureAccessToken();

    // Gửi trả lời
    const resp = await sendText(accessToken, userId, reply);
    console.log('[WEBHOOK] sendText resp:', resp);

    return res.status(200).send('ok');
  } catch (e) {
    console.error('[WEBHOOK] error:', e);
    return res.status(200).send('ok'); // vẫn trả 200 để Zalo không retry quá nhiều
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const k = (process.env.GOOGLE_API_KEY || '').trim();
  console.log(`✅ Server listening on port ${port}`);
  console.log(`ENV check: GOOGLE_API_KEY len=${k.length}, ZALO_APP_ID=${process.env.ZALO_APP_ID}`);
});
