import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import path from "path";

import { sendText } from "./zaloApi.js";
import { generateReply } from "./gemini.js";

const app = express();
app.use(bodyParser.json());

// --- Serve file HTML xác thực trong /webhook/ ---
app.use("/webhook", express.static(path.join(process.cwd(), "webhook-files")));

// --- Verify signature (nếu cần) ---
function verifySignature(req) {
  const secret = process.env.ZALO_APP_SECRET_WEBHOOK;
  if (!secret) return true;
  const sig = req.headers["x-zalo-signature"] || req.headers["x-zalo-sig"];
  if (!sig) return true;
  const bodyStr = JSON.stringify(req.body);
  const h = crypto.createHmac("sha256", secret).update(bodyStr).digest("hex");
  return h === sig;
}

// --- Webhook GET: vẫn giữ verify_token và challenge ---
app.get("/webhook", (req, res) => {
  const token = req.query.verify_token;
  const challenge = req.query.challenge;
  if (token === process.env.VERIFY_TOKEN && challenge) {
    return res.send(challenge);
  }
  res.status(200).send("ok");
});

// --- Webhook POST: nhận message Zalo ---
app.post("/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) return res.status(403).send("invalid signature");

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

    if (!userId || !text) {
      console.log(
        "Unrecognized webhook shape:",
        JSON.stringify(event).slice(0, 400)
      );
      return res.status(200).send("ignored");
    }

    const history = []; // có thể lưu DB nếu muốn
    const reply = await generateReply(history, text);
    const accessToken = await ensureAccessToken();
    await sendText(accessToken, userId, reply);

    res.status(200).send("ok");
  } catch (e) {
    console.error("webhook error", e);
    res.status(500).send("error");
  }
});

// --- OAuth callback ---
app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code || "";
  res.send(`
    <h3>OAuth callback</h3>
    <p>Code nhận được: <code>${code}</code></p>
    <p>Để đổi code sang token và lưu vào <b>tokens.json</b>, chạy:</p>
    <pre>OAUTH_CODE_ONCE=${code} npm run exchange:code</pre>
  `);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
