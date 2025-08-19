// zaloApi.js
import axios from 'axios';

const API_BASE = process.env.ZALO_API_BASE || 'https://openapi.zalo.me';

// Gửi text qua V3 CS endpoint
export async function sendText(accessToken, userId, text) {
  const url = `${API_BASE}/v3.0/oa/message/cs`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'access_token': accessToken
  };
  const payload = {
    recipient: { user_id: userId },
    message: { text }
  };

  const { data } = await axios.post(url, payload, { headers });
  if (data?.error && data?.error !== 0) {
    console.error('Zalo send error:', data);
  }
  return data;
}
