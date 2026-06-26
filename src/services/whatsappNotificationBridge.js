import axios from 'axios';
import logger from '../utils/logger.js';

const trimOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const LOCAL_WHATSAPP_BACKEND_URL = 'http://localhost:3001';
const PRODUCTION_WHATSAPP_BACKEND_URL = 'https://nexion-broadcast-backend-s9av.onrender.com';

const isHostedRuntime = () => {
  const baseUrl = trimOrNull(process.env.BASE_URL) || '';
  return Boolean(
    process.env.NODE_ENV === 'production' ||
    process.env.RENDER ||
    process.env.RENDER_SERVICE_ID ||
    process.env.RENDER_SERVICE_NAME ||
    (baseUrl && !baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1'))
  );
};

const resolveBridgeBaseUrl = () => {
  const configuredUrl = trimOrNull(process.env.WHATSAPP_BACKEND_INTERNAL_URL);
  if (configuredUrl) return configuredUrl;
  return isHostedRuntime()
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
    logger.info(`WhatsApp notification bridge target: ${this.baseUrl}${this.notifyPath}; enabled=${this.enabled}`);
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
      logger.warn(`WhatsApp notification bridge failed at ${this.baseUrl}${this.notifyPath}: ${status ? `${status} ` : ''}${responseError}`);
      return {
        success: false,
        error: status ? `${status}: ${responseError}` : responseError
      };
    }
  }
}

export default new WhatsAppNotificationBridge();
