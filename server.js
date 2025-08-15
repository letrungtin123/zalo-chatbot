import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { sendText } from "./zaloApi.js";
import { generateReply } from "./gemini.js";
import { ensureAccessToken } from "./zaloOAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Serve toàn bộ file trong /verify
app.use('/verify', express.static(path.join(__dirname, 'verify')));

// --- Webhook nhận message ---
app.post("/webhook", async (req, res) => {
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
    if (!userId || !text) return res.status(200).send("ignored");

    const history = []; // demo
    const reply = await generateReply(history, text);
    const accessToken = await ensureAccessToken();
    await sendText(accessToken, userId, reply);

    res.status(200).send("ok");
  } catch (e) {
    console.error("webhook error", e);
    res.status(500).send("error");
  }
});

// --- OAuth callback (nếu dùng) ---
app.get("/oauth/callback", (req, res) => {
  const code = req.query.code || "";
  res.send(`<h3>OAuth callback</h3><p>Code: ${code}</p>`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
