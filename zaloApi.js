// zaloApi.js
import axios from "axios";

const API_BASE = process.env.ZALO_API_BASE || "https://openapi.zalo.me";

/**
 * Gửi tin nhắn text tới user
 * @param {string} accessToken - OA access token
 * @param {string} userId      - Zalo user id (sender.id)
 * @param {string} text        - message
 */
export async function sendText(accessToken, userId, text) {
  const url = `${API_BASE}/v2.0/oa/message`;

  const payload = {
    recipient: { user_id: userId },
    message: { text: String(text || "").slice(0, 2000) },
  };

  try {
    const { data } = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          access_token: accessToken,   // v2 yêu cầu token ở header, KHÔNG để ở query
        }
      });

    if (data?.error || data?.message === "error") {
      console.error("Zalo send error:", data);
    }
    return data;
  } catch (e) {
    console.error("Zalo send exception:", e?.response?.data || e.message);
    return { error: -1, message: "exception" };
  }
}
