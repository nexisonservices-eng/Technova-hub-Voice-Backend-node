import axios from 'axios';
import cron from 'node-cron';
import logger from '../utils/logger.js';

class ExotelService {
  constructor() {
    this.apiKey = process.env.EXOTEL_API_KEY || '';
    this.apiToken = process.env.EXOTEL_API_TOKEN || '';
    this.accountSid = process.env.EXOTEL_ACCOUNT_SID || '';
    this.subdomain = process.env.EXOTEL_SUBDOMAIN || '';
    this.defaultFromNumber = process.env.EXOTEL_NUMBER || '';
    this.rotationCursor = 0;
  }

  isConfigured() {
    return Boolean(
      this.apiKey &&
      this.apiToken &&
      this.accountSid &&
      this.subdomain &&
      this.defaultFromNumber
    );
  }

  getNumberPool() {
    const configuredPool = String(process.env.EXOTEL_NUMBER_POOL || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (!configuredPool.length) {
      return [this.defaultFromNumber].filter(Boolean);
    }

    return configuredPool;
  }

  buildConnectUrl() {
    return `https://${this.subdomain}/v1/Accounts/${this.accountSid}/Calls/connect.json`;
  }

  getWebhookUrl() {
    const baseUrl = String(process.env.BASE_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      throw new Error('BASE_URL is required for Exotel webhook callbacks');
    }

    return `${baseUrl}/webhook/ivr`;
  }

  getIstHour() {
    const hourString = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      hour12: false
    }).format(new Date());

    return Number.parseInt(hourString, 10);
  }

  isTraiAllowedNow() {
    const hour = this.getIstHour();
    return Number.isFinite(hour) && hour >= 9 && hour < 21;
  }

  dynamicCallerId() {
    const pool = this.getNumberPool();
    if (!pool.length) {
      throw new Error('No Exotel caller IDs available for rotation');
    }

    const callerId = pool[this.rotationCursor % pool.length];
    this.rotationCursor = (this.rotationCursor + 1) % pool.length;

    return {
      callerId,
      poolSize: pool.length,
      nextCursor: this.rotationCursor
    };
  }

  scheduleCampaigns({ cronExpression, timezone = 'Asia/Kolkata', onTick }) {
    if (!cron.validate(cronExpression)) {
      throw new Error('Invalid cron expression for scheduleCampaigns');
    }

    const task = cron.schedule(cronExpression, async () => {
      if (!this.isTraiAllowedNow()) {
        logger.warn('TRAI window blocked a scheduled outbound campaign run', {
          cronExpression,
          timezone
        });
        return;
      }

      if (typeof onTick === 'function') {
        await onTick();
      }
    }, {
      timezone
    });

    return task;
  }

  retryQueue({ calls = [], maxAttempts = 3, retryGapHours = 2 }) {
    const now = new Date();
    const retryable = calls.filter((call) => {
      const attempts = Number(call?.retryAttempt || 0);
      if (attempts >= maxAttempts) return false;
      if (String(call?.status || '').toLowerCase() !== 'failed') return false;

      const nextRetryAt = call?.nextRetryAt ? new Date(call.nextRetryAt) : null;
      if (!nextRetryAt) return true;
      return nextRetryAt <= now;
    });

    return {
      retryable,
      maxAttempts,
      retryGapHours,
      nextRetryAt: new Date(now.getTime() + retryGapHours * 60 * 60 * 1000)
    };
  }

  abTest({ numbers = [], templates = [] }) {
    const validTemplates = templates.filter((item) => item?.template);
    if (validTemplates.length < 2) {
      throw new Error('A/B test needs at least two templates');
    }

    const midpoint = Math.ceil(numbers.length / 2);
    const groupA = numbers.slice(0, midpoint);
    const groupB = numbers.slice(midpoint);

    return {
      groups: [
        {
          key: validTemplates[0].key || 'A',
          template: validTemplates[0].template,
          numbers: groupA
        },
        {
          key: validTemplates[1].key || 'B',
          template: validTemplates[1].template,
          numbers: groupB
        }
      ],
      winner: ''
    };
  }

  async createOutboundLocalCall({ to, from, appParams = {} }) {
    if (!this.isConfigured()) {
      throw new Error('Exotel is not configured. Missing one or more EXOTEL_* environment variables.');
    }

    const fromNumber = from || this.defaultFromNumber;
    const callbackUrl = this.getWebhookUrl();

    const payload = new URLSearchParams({
      From: fromNumber,
      To: to,
      CallerId: fromNumber,
      Url: callbackUrl,
      CallType: 'trans',
      TimeLimit: String(process.env.EXOTEL_TIME_LIMIT_SECONDS || 600)
    });

    if (Object.keys(appParams || {}).length > 0) {
      payload.append('CustomField', JSON.stringify(appParams));
    }

    const response = await axios.post(this.buildConnectUrl(), payload, {
      auth: {
        username: this.apiKey,
        password: this.apiToken
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: Number(process.env.EXOTEL_API_TIMEOUT_MS || 15000)
    });

    const callData = response?.data?.Call || response?.data?.call || {};
    const callSid = callData?.Sid || callData?.sid || callData?.CallSid || callData?.call_sid;

    if (!callSid) {
      logger.warn('Exotel call created without explicit SID in response', { response: response?.data });
    }

    return {
      callSid: callSid || `exotel_${Date.now()}`,
      status: String(callData?.Status || callData?.status || 'initiated').toLowerCase(),
      raw: response?.data || {}
    };
  }
}

export default new ExotelService();

