import axios from 'axios';
import logger from '../utils/logger.js';

const trimOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const LOCAL_WHATSAPP_BACKEND_URL = 'http://localhost:3001';
const PRODUCTION_WHATSAPP_BACKEND_URL = 'https://nexion-broadcast-backend-s9av.onrender.com';

const resolveBridgeBaseUrl = () => {
  const configuredUrl = trimOrNull(process.env.WHATSAPP_BACKEND_INTERNAL_URL);
  if (configuredUrl) return configuredUrl;
  return process.env.NODE_ENV === 'production'
    ? PRODUCTION_WHATSAPP_BACKEND_URL
    : LOCAL_WHATSAPP_BACKEND_URL;
};

const normalizeBridgeError = (value, fallback = 'WhatsApp bridge request failed') => {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === 'object') {
    const nested =
      value.message ||
      value.error_user_msg ||
      value.error_user_title ||
      value.details ||
      value.error ||
      value.title ||
      value.description;
    if (nested && nested !== value) return normalizeBridgeError(nested, fallback);
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return String(value || fallback);
};

class WhatsAppNotificationBridge {
  constructor() {
    this.baseUrl = resolveBridgeBaseUrl();
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
      const responseData = error?.response?.data;
      const responseError =
        normalizeBridgeError(
          responseData?.error ||
            responseData?.message ||
            responseData ||
            error?.message,
          'WhatsApp bridge request failed'
        );
      const status = error?.response?.status || null;
      logger.warn(`WhatsApp notification bridge failed: ${status ? `${status} ` : ''}${responseError}`);
      return {
        success: false,
        error: status ? `${status}: ${responseError}` : responseError
      };
    }
  }
}

export default new WhatsAppNotificationBridge();
