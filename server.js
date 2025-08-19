// server.js (chỉ cắt phần cần thêm/sửa)

import cron from "node-cron";
import { sendCS } from "./zaloApi.js";
import { ensureAccessToken } from "./zaloOAuth.js";
import { addSub, removeSub, loadSubs } from "./subscribersStore.js";

// ... code cũ giữ nguyên

// 1) Cập nhật subscribers từ webhook
app.post("/webhook", async (req, res) => {
  try {
    const raw = req.body || {};
    const ev = raw?.event_name;
    const senderId = raw?.sender?.id || raw?.sender?.user_id;
    const recipientId = raw?.recipient?.id || raw?.recipient?.user_id;

    // user follow / unfollow
    if (ev === "user_follow" && senderId) {
      await addSub(senderId);
    }
    if (ev === "user_unfollow" && senderId) {
      await removeSub(senderId);
    }

    // ai nhắn tin đến OA -> add vào list
    if (ev === "user_send_text" && senderId) {
      await addSub(senderId);
    }

    // ======== phần xử lý chat bot cũ của bạn ở đây ========
    // ...
    // =====================================================

    res.status(200).send("ok");
  } catch (e) {
    console.error("[WEBHOOK] error:", e);
    res.status(500).send("error");
  }
});

// 2) Hàm broadcast
async function broadcastAll(text) {
  const accessToken = await ensureAccessToken();
  const ids = await loadSubs();
  if (!ids.length) {
    console.log("[BROADCAST] List empty.");
    return { ok: 0, fail: 0, total: 0 };
  }

  console.log(`[BROADCAST] Sending to ${ids.length} users ...`);

  let ok = 0, fail = 0;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  for (const uid of ids) {
    try {
      const resp = await sendCS(accessToken, uid, text);
      if (resp?.error === 0) ok++;
      else fail++;
    } catch (err) {
      fail++;
      console.error("[BROADCAST] send error for", uid, err?.response?.data || err?.message);
    }
    // Chậm lại ~8–10 msg/s để tránh rate limit
    await sleep(120);
  }

  console.log("[BROADCAST] done:", { ok, fail, total: ids.length });
  return { ok, fail, total: ids.length };
}

// 3) Cron theo cấu hình ENV
const TZ = process.env.TZ || "Asia/Ho_Chi_Minh";
const BROADCAST_CRON = process.env.BROADCAST_CRON || ""; // ví dụ: "30 8 * * *" (8:30 hàng ngày)
const BROADCAST_TEXT = process.env.BROADCAST_TEXT || "✨ Thông báo từ OA: Chúc bạn một ngày tốt lành!";

if (BROADCAST_CRON) {
  console.log("[CRON] schedule:", BROADCAST_CRON, "TZ:", TZ);
  cron.schedule(BROADCAST_CRON, async () => {
    try {
      await broadcastAll(BROADCAST_TEXT);
    } catch (e) {
      console.error("[CRON] broadcast error:", e);
    }
  }, { timezone: TZ });
}

// 4) Admin trigger thủ công (đặt key để tránh public)
app.post("/admin/broadcast", async (req, res) => {
  const key = req.query.key || req.body?.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(403).send("forbidden");
  }
  const text = req.body?.text || BROADCAST_TEXT;
  const out = await broadcastAll(text);
  res.json(out);
});
