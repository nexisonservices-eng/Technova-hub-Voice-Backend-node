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

const clampNumber = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

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

const buildFallbackRequestKey = (payload = {}) => {
  const metadata = payload?.metadata || {};
  return [
    metadata?.requestKey || '',
    metadata?.callSid || '',
    metadata?.event || '',
    metadata?.bookingId || metadata?.bookingReference || '',
    metadata?.nodeId || '',
    metadata?.workflowId || '',
    payload?.recipient || '',
    payload?.messageType || '',
    payload?.templateName || payload?.requestedTemplateName || '',
    payload?.language || '',
    payload?.text || ''
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('|');
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
    this.minDispatchIntervalMs = clampNumber(process.env.WHATSAPP_BACKEND_INTERNAL_MIN_DISPATCH_INTERVAL_MS, 0, 60000, 1200);
    this.maxAttempts = clampNumber(process.env.WHATSAPP_BACKEND_INTERNAL_MAX_ATTEMPTS, 1, 5, 3);
    this.maxRetryDelayMs = clampNumber(process.env.WHATSAPP_BACKEND_INTERNAL_MAX_RETRY_DELAY_MS, 1000, 60000, 30000);
    this.successCacheTtlMs = clampNumber(process.env.WHATSAPP_BACKEND_INTERNAL_SUCCESS_CACHE_TTL_MS, 60000, 60 * 60 * 1000, 15 * 60 * 1000);
    this.inFlightRequests = new Map();
    this.recentSuccessfulRequests = new Map();
    this.lastDispatchAt = 0;
    this.sendQueue = Promise.resolve();
    logger.info(
      `WhatsApp notification bridge target: ${this.baseUrl || 'missing'}${this.notifyPath}; enabled=${this.enabled}; timeoutMs=${this.timeoutMs}; minDispatchIntervalMs=${this.minDispatchIntervalMs}; maxAttempts=${this.maxAttempts}; apiKey=${maskSecret(this.apiKey)}`
    );
  }

  get enabled() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  get configurationError() {
    return this.enabled ? null : buildMissingConfigError();
  }

  _getRequestKey(payload = {}) {
    return buildFallbackRequestKey(payload);
  }

  _pruneRecentSuccesses(now = Date.now()) {
    for (const [requestKey, entry] of this.recentSuccessfulRequests.entries()) {
      if (!entry || entry.expiresAt <= now) {
        this.recentSuccessfulRequests.delete(requestKey);
      }
    }
  }

  _rememberSuccess(requestKey, response) {
    if (!requestKey) return;
    this.recentSuccessfulRequests.set(requestKey, {
      response,
      expiresAt: Date.now() + this.successCacheTtlMs
    });
  }

  async _respectDispatchInterval() {
    if (!this.minDispatchIntervalMs) return;
    const elapsed = Date.now() - this.lastDispatchAt;
    const waitMs = this.minDispatchIntervalMs - elapsed;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  async _sendWithRetry(payload = {}, requestLog = {}, requestKey = '') {
    const requestConfig = {
      timeout: this.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': this.apiKey
      }
    };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
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

        const result = response.data || { success: true };
        logger.info('WhatsApp notification bridge response', {
          attempt,
          status: response.status,
          statusText: response.statusText,
          ...requestLog,
          responseBody: result
        });
        this._rememberSuccess(requestKey, result);
        return result;
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

        const shouldRetry = attempt < this.maxAttempts && status === 429;
        if (shouldRetry) {
          const retryAfterSeconds = Number(retryAfterHeader);
          const retryDelayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? clampNumber(retryAfterSeconds * 1000, 1000, this.maxRetryDelayMs, 1000)
            : clampNumber(1500 * (2 ** (attempt - 1)), 1000, this.maxRetryDelayMs, 1500);
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
      } finally {
        this.lastDispatchAt = Date.now();
      }
    }
    return {
      success: false,
      error: 'WhatsApp bridge request failed'
    };
  }

  async sendNotification(payload = {}) {
    if (!this.enabled) {
      return { success: false, error: this.configurationError };
    }

    const requestKey = this._getRequestKey(payload);
    const requestLog = {
      ...buildRequestLog(this.baseUrl, this.notifyPath, payload),
      requestKey
    };

    this._pruneRecentSuccesses();

    if (requestKey && this.recentSuccessfulRequests.has(requestKey)) {
      logger.info('WhatsApp notification bridge deduplicated recent request', requestLog);
      return this.recentSuccessfulRequests.get(requestKey).response;
    }

    if (requestKey && this.inFlightRequests.has(requestKey)) {
      logger.info('WhatsApp notification bridge joined in-flight request', requestLog);
      return this.inFlightRequests.get(requestKey);
    }

    const task = async () => {
      await this._respectDispatchInterval();
      return this._sendWithRetry(payload, requestLog, requestKey);
    };

    const execution = this.sendQueue.then(task, task);
    this.sendQueue = execution.then(() => undefined, () => undefined);

    if (requestKey) {
      this.inFlightRequests.set(requestKey, execution);
    }

    try {
      return await execution;
    } finally {
      if (requestKey) {
        this.inFlightRequests.delete(requestKey);
      }
    }
  }
}

export default new WhatsAppNotificationBridge();
