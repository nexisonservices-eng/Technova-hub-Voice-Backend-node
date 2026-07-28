import axios from 'axios';
import logger from '../utils/logger.js';

const trimOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const resolveBridgeBaseUrl = () => {
  return trimOrNull(process.env.WHATSAPP_BACKEND_INTERNAL_URL);
};

const resolveBridgeApiKey = () =>
  trimOrNull(
    process.env.WHATSAPP_BACKEND_INTERNAL_API_KEY ||
    process.env.INTERNAL_API_KEY ||
    process.env.ADMIN_INTERNAL_API_KEY
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const maskSecret = (value = '') => {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
};

const buildRequestLog = (baseUrl, notifyPath, payload = {}) => {
  const metadata = payload?.metadata || {};
  return {
    target: `${baseUrl}${notifyPath}`,
    recipient: payload?.recipient || '',
    messageType: payload?.messageType || '',
    templateName: payload?.templateName || '',
    requestedTemplateName: payload?.requestedTemplateName || '',
    language: payload?.language || '',
    userId: payload?.userId || '',
    companyId: payload?.companyId || '',
    callSid: metadata?.callSid || '',
    event: metadata?.event || '',
    bookingId: metadata?.bookingId || metadata?.bookingReference || '',
    nodeId: metadata?.nodeId || '',
    workflowId: metadata?.workflowId || '',
    requestKey: metadata?.requestKey || ''
  };
};

const buildMissingConfigError = () => {
  const missing = [];
  if (!resolveBridgeBaseUrl()) missing.push('WHATSAPP_BACKEND_INTERNAL_URL');
  if (!resolveBridgeApiKey()) missing.push('WHATSAPP_BACKEND_INTERNAL_API_KEY');
  return `WhatsApp notification bridge is not configured (${missing.join(', ')})`;
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
    this.apiKey = resolveBridgeApiKey();
    this.timeoutMs = Number(process.env.WHATSAPP_BACKEND_INTERNAL_TIMEOUT_MS || 15000);
    this.notifyPath = trimOrNull(process.env.WHATSAPP_BACKEND_INTERNAL_NOTIFY_PATH) || '/internal/ivr/notify';
    logger.info(
      `WhatsApp notification bridge target: ${this.baseUrl || 'missing'}${this.notifyPath}; enabled=${this.enabled}; timeoutMs=${this.timeoutMs}; apiKey=${maskSecret(this.apiKey)}`
    );
  }

  get enabled() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  get configurationError() {
    return this.enabled ? null : buildMissingConfigError();
  }

  async sendNotification(payload = {}) {
    if (!this.enabled) {
      return { success: false, error: this.configurationError };
    }

    const requestLog = buildRequestLog(this.baseUrl, this.notifyPath, payload);
    const requestConfig = {
      timeout: this.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': this.apiKey
      }
    };
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        logger.info('WhatsApp notification bridge request', {
          attempt,
          ...requestLog
        });

        const response = await axios.post(
          `${this.baseUrl}${this.notifyPath}`,
          payload,
          requestConfig
        );

        logger.info('WhatsApp notification bridge response', {
          attempt,
          status: response.status,
          statusText: response.statusText,
          ...requestLog,
          responseBody: response.data || null
        });
        return response.data || { success: true };
      } catch (error) {
        const responseData = error?.response?.data;
        const status = error?.response?.status || null;
        const responseError = normalizeBridgeError(
          responseData?.error ||
            responseData?.message ||
            responseData ||
            error?.message,
          'WhatsApp bridge request failed'
        );
        const retryAfterHeader = error?.response?.headers?.['retry-after'];

        logger.warn('WhatsApp notification bridge failed', {
          attempt,
          status,
          statusText: error?.response?.statusText || '',
          ...requestLog,
          requestBody: payload,
          responseHeaders: error?.response?.headers || null,
          responseBody: responseData || null,
          error: responseError
        });

        const shouldRetry =
          attempt < maxAttempts &&
          status === 429;

        if (shouldRetry) {
          const retryAfterSeconds = Number(retryAfterHeader);
          const retryDelayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds * 1000, 3000)
            : 500;
          logger.warn('Retrying WhatsApp notification bridge after 429', {
            attempt,
            retryDelayMs,
            ...requestLog
          });
          await sleep(retryDelayMs);
          continue;
        }

        return {
          success: false,
          error: status ? `${status}: ${responseError}` : responseError
        };
      }
    }
  }
}

export default new WhatsAppNotificationBridge();
