// zaloApi.js
import axios from "axios";

const API_BASE = process.env.ZALO_API_BASE || "https://openapi.zalo.me";

// V3 CS API: https://go.zalo.me/api-v3
export async function sendText(accessToken, userId, text) {
  const url = `${API_BASE}/v3.0/oa/message/cs`;
  const payload = {
    recipient: { user_id: String(userId) },
    message: { text: String(text) },
  };

  const { data } = await axios.post(url, payload, {
    headers: {
      "access_token": accessToken,        // V3 yêu cầu token ở HEADER
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    timeout: 10000,
  });

  if (data?.error && data?.error !== 0) {
    console.error("Zalo send error:", data);
  }
  return data;
}
