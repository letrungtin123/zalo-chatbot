import axios from 'axios';
const API_BASE = process.env.ZALO_API_BASE || 'https://openapi.zalo.me';

// Gửi text
export async function sendText(accessToken, userId, text) {
  const url = `${API_BASE}/v2.0/oa/message?access_token=${encodeURIComponent(accessToken)}`;
  const payload = {
    recipient: { user_id: userId },
    message: { text }
  };
  const { data } = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }});
  if (data?.error || data?.message === 'error') {
    console.error('Zalo send error:', data);
  }
  return data;
}
