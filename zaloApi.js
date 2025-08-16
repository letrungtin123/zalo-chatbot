// zaloApi.js
import axios from 'axios';
const API_BASE = process.env.ZALO_API_BASE || 'https://openapi.zalo.me';

export async function sendText(accessToken, userId, text) {
  const url = `${API_BASE}/v3.0/oa/message`; // <— v3.0
  const payload = {
    recipient: { user_id: userId },
    message:   { text }
  };

  const { data } = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'access_token': accessToken,       // v3 vẫn yêu cầu token ở header
    },
    timeout: 10000,
  });

  if (data?.error && data?.error !== 0) {
    console.error('Zalo send error:', data);
  }
  return data;
}
