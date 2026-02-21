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

  getFromCache(phoneNumber) {
    const hit = this.cache.get(phoneNumber);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.cache.delete(phoneNumber);
      return null;
    }
    return hit.data;
  }

  saveToCache(phoneNumber, data) {
    this.cache.set(phoneNumber, {
      data,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  async getTwilioCredentialsByPhoneNumber(phoneNumber) {
    if (!this.isReady() || !phoneNumber) return null;

    const cached = this.getFromCache(phoneNumber);
    if (cached) return cached;

    try {
      const encoded = encodeURIComponent(phoneNumber);
      const url = `${this.adminBaseUrl}/internal/twilio/credentials/by-phone-number/${encoded}`;
      const response = await axios.get(url, {
        timeout: Number(process.env.ADMIN_API_TIMEOUT_MS || 5000),
        headers: {
          'x-internal-api-key': this.internalApiKey,
        },
      });

      const data = response?.data?.data || null;
      if (data) {
        this.saveToCache(phoneNumber, data);
      }
      return data;
    } catch (error) {
      logger.warn('Failed to resolve admin Twilio credentials by phone number', {
        phoneNumber,
        message: error.message,
      });
      return null;
    }
  }
}

export default new AdminCredentialsService();
