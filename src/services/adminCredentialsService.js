import axios from 'axios';
import logger from '../utils/logger.js';

class AdminCredentialsService {
  constructor() {
    this.cache = new Map();
    this.ttlMs = Number(process.env.ADMIN_CREDENTIALS_CACHE_MS || 60_000);
  }

  get adminBaseUrl() {
    return (
      process.env.ADMIN_BACKEND_URL ||
      process.env.ADMIN_API_BASE_URL ||
      process.env.ADMIN_SERVICE_URL ||
      ''
    ).replace(/\/$/, '');
  }

  get internalApiKey() {
    return process.env.INTERNAL_API_KEY || '';
  }

  isReady() {
    return Boolean(this.adminBaseUrl && this.internalApiKey);
  }

  getFromCache(key) {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return hit.data;
  }

  saveToCache(key, data) {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  async fetchCredentials(path, cacheKey) {
    if (!this.isReady() || !path || !cacheKey) return null;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const url = `${this.adminBaseUrl}${path}`;
      const response = await axios.get(url, {
        timeout: Number(process.env.ADMIN_API_TIMEOUT_MS || 5000),
        headers: {
          'x-internal-api-key': this.internalApiKey,
        },
      });

      const data = response?.data?.data || null;
      if (data) {
        this.saveToCache(cacheKey, data);
      }
      return data;
    } catch (error) {
      logger.warn('Failed to resolve admin Twilio credentials', {
        path,
        message: error.message
      });
      return null;
    }
  }

  async getTwilioCredentialsByPhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;
    const encoded = encodeURIComponent(phoneNumber);
    return this.fetchCredentials(
      `/internal/twilio/credentials/by-phone-number/${encoded}`,
      `phone:${phoneNumber}`
    );
  }

  async getTwilioCredentialsByUserId(userId) {
    if (!userId) return null;
    const encoded = encodeURIComponent(userId);
    return this.fetchCredentials(
      `/internal/twilio/credentials/by-user-id/${encoded}`,
      `user:${userId}`
    );
  }
}

export default new AdminCredentialsService();
