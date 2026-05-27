import axios from 'axios';
import logger from '../utils/logger.js';

const trimOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

class WhatsAppNotificationBridge {
  constructor() {
    this.baseUrl = trimOrNull(process.env.WHATSAPP_BACKEND_INTERNAL_URL) || 'http://localhost:3000';
    this.apiKey = trimOrNull(process.env.WHATSAPP_BACKEND_INTERNAL_API_KEY || process.env.INTERNAL_API_KEY || process.env.ADMIN_INTERNAL_API_KEY);
    this.timeoutMs = Number(process.env.WHATSAPP_BACKEND_INTERNAL_TIMEOUT_MS || 15000);
    this.notifyPath = trimOrNull(process.env.WHATSAPP_BACKEND_INTERNAL_NOTIFY_PATH) || '/internal/ivr/notify';
  }

  get enabled() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  async sendNotification(payload = {}) {
    if (!this.enabled) {
      return { success: false, error: 'WhatsApp notification bridge is not configured' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}${this.notifyPath}`,
        payload,
        {
          timeout: this.timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'x-internal-api-key': this.apiKey
          }
        }
      );
      return response.data || { success: true };
    } catch (error) {
      logger.warn(`WhatsApp notification bridge failed: ${error?.message || error}`);
      return {
        success: false,
        error: error?.response?.data?.error || error?.response?.data?.message || error?.message || 'WhatsApp bridge request failed'
      };
    }
  }
}

export default new WhatsAppNotificationBridge();
