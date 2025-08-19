// zaloApi.js
import axios from 'axios';
const API_BASE = process.env.ZALO_API_BASE || 'https://openapi.zalo.me';

// Gửi text (Message V3 CS)
export async function sendText(accessToken, userId, text) {
  const url = `${API_BASE}/v3.0/oa/message/cs`;
  const payload = {
    recipient: { user_id: userId },
    message  : { text },
  };
  const { data } = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'access_token': accessToken, // V3 yêu cầu token trong HEADER
      'Accept': 'application/json',
    },
    timeout: 15000,
  });
  if (data?.error && data?.error !== 0) {
    console.error('Zalo send error:', data);
  }
  return data;
}
