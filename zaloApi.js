// zaloApi.js
import axios from "axios";
const API_BASE = process.env.ZALO_API_BASE || "https://openapi.zalo.me";

// Gửi text qua Message V3 (CS: trong khung 24h)
export async function sendText(accessToken, userId, text) {
  const url = `${API_BASE}/v3.0/oa/message/cs`;
  const payload = {
    recipient: { user_id: userId },
    message: { text }
  };
  const { data } = await axios.post(url, payload, {
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "access_token": accessToken
    },
    timeout: 10000
  });
  if (data?.error) console.error("Zalo send error:", data);
  return data;
}
