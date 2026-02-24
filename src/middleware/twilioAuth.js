import twilio from 'twilio';
import logger from '../utils/logger.js';
import adminCredentialsService from '../services/adminCredentialsService.js';

const normalizePhone = (value) => {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) return digits;
  return `+${digits}`;
};

const resolveWebhookUrl = (req) => {
  const base = (process.env.PUBLIC_WEBHOOK_BASE_URL || process.env.BASE_URL || '').trim();
  if (base) {
    return `${base.replace(/\/$/, '')}${req.originalUrl}`;
  }
  return `${req.protocol}://${req.get('host')}${req.originalUrl}`;
};

const allowUnsignedInDev = () =>
  String(process.env.ALLOW_UNSIGNED_TWILIO || '').toLowerCase() === 'true' &&
  process.env.NODE_ENV !== 'production';

const resolveAuthContext = async (req) => {
  const fromNumber = normalizePhone(req.body?.From || req.query?.From || '');
  let authToken = '';
  let tenant = null;

  if (fromNumber) {
    tenant = await adminCredentialsService.getTwilioCredentialsByPhoneNumber(fromNumber);
    if (tenant?.twilioAuthToken) {
      authToken = tenant.twilioAuthToken;
    }
  }

  return { authToken, fromNumber, tenant };
};

export const verifyTwilioRequest = async (req, res, next) => {
  const twilioSignature = req.headers['x-twilio-signature'];

  if (!twilioSignature) {
    if (allowUnsignedInDev()) {
      logger.warn('Skipping Twilio signature validation in development');
      return next();
    }
    return res.status(403).send('Forbidden: Missing Twilio signature');
  }

  try {
    const { authToken, fromNumber, tenant } = await resolveAuthContext(req);

    if (!authToken) {
      logger.error('Twilio auth token is not configured');
      return res.status(500).send('Twilio auth configuration missing');
    }

    const url = resolveWebhookUrl(req);
    const params = req.body || {};

    const isValid = twilio.validateRequest(authToken, twilioSignature, url, params);

    if (!isValid) {
      return res.status(403).send('Forbidden: Invalid Twilio signature');
    }

    if (tenant) {
      req.tenantContext = {
        adminId: String(tenant.userId),
        fromNumber,
        twilioAccountSid: tenant.twilioAccountSid || null,
      };
    }

    return next();
  } catch (error) {
    logger.error('Twilio signature validation failed', { message: error.message });
    return res.status(500).send('Failed to validate Twilio signature');
  }
};
