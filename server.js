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
app.use(bodyParser.json());

// --- Serve folder /verify cho Zalo HTML verification ---
app.use('/verify', express.static(path.join(__dirname, 'verify'), {
  setHeaders: (res) => {
    res.set('Content-Type', 'text/html');
  }
}));

// --- Log requests to /verify for debugging ---
app.get('/verify/*', (req, res, next) => {
  console.log(`Request to /verify: ${req.path}`);
  next();
});

// --- Webhook nhận message từ OA ---
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body || {};
    const userId = event?.sender?.user_id || event?.user?.user_id || event?.recipient?.user_id || null;
    const text = event?.message?.text || event?.message?.content?.text || event?.text || null;
    if (!userId || !text) return res.status(200).send('ignored');
    const history = []; // demo
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
  res.send(`<h3>OAuth callback</h3><p>Code: ${code}</p>`);
});

// --- Webhook verify token (optional) ---
app.get('/webhook', (req, res) => {
  if (req.query?.verify_token === process.env.VERIFY_TOKEN) return res.send('verified');
  if (req.query?.challenge) return res.send(req.query.challenge);
  res.send('ok');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));