// zaloApi.js
import axios from "axios";
const API_BASE = process.env.ZALO_API_BASE || "https://openapi.zalo.me";

export async function sendText(accessToken, userId, text) {
  const url = `${API_BASE}/v2.0/oa/message`;
  const payload = {
    recipient: { user_id: userId },
    message: { text },
  };

  const { data } = await axios.post(url, payload, {
    headers: {
      "Content-Type": "application/json",
      // Zalo chấp nhận 1 trong 2 cách dưới đây. Dùng cái đầu tiên trước:
      access_token: accessToken,
      // Nếu vẫn báo lỗi, thử chuyển sang:
      // 'Authorization': `Bearer ${accessToken}`,
    },
    timeout: 15000,
  });

  if (data?.error && data.error !== 0) {
    console.error("Zalo send error:", data);
  }
  return data;
}
