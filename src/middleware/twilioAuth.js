import twilio from 'twilio';
import logger from '../utils/logger.js';
import adminCredentialsService from '../services/adminCredentialsService.js';
import Call from '../models/call.js';

const normalizePhone = (value) => {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) return digits;
  return `+${digits}`;
};

const resolveWebhookUrl = (req) => {
  const base = (process.env.PUBLIC_WEBHOOK_BASE_URL || process.env.BASE_URL || '').trim();
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || req.get('host');
  const protocol = forwardedProto || req.protocol || 'https';

  if (host) {
    return `${protocol}://${host}${req.originalUrl}`;
  }

  if (base) {
    return `${base.replace(/\/$/, '')}${req.originalUrl}`;
  }

  return `${protocol}://${req.get('host')}${req.originalUrl}`;
};

const buildWebhookDebugContext = (req, url) => {
  const parsedUrl = new URL(url);
  return {
    validationUrl: String(process.env.TWILIO_SIGNATURE_DEBUG_FULL_URL || '').toLowerCase() === 'true'
      ? url
      : `${parsedUrl.origin}${parsedUrl.pathname}`,
    queryKeys: Array.from(parsedUrl.searchParams.keys()),
    method: req.method,
    path: req.originalUrl.split('?')[0],
    hasSignature: Boolean(req.headers['x-twilio-signature']),
    host: req.get('host'),
    forwardedHost: req.get('x-forwarded-host') || null,
    forwardedProto: req.get('x-forwarded-proto') || null
  };
};

const allowUnsignedInDev = () =>
  String(process.env.ALLOW_UNSIGNED_TWILIO || '').toLowerCase() === 'true' &&
  process.env.NODE_ENV !== 'production';

const resolveAuthContext = async (req) => {
  const fromNumber = normalizePhone(req.body?.From || req.query?.From || '');
  const toNumber = normalizePhone(req.body?.To || req.query?.To || '');
  const queryUserId = String(req.query?.userId || '').trim();
  const callSid = String(
    req.body?.CallSid ||
    req.query?.CallSid ||
    req.body?.callSid ||
    req.query?.callSid ||
    ''
  ).trim();
  let authToken = '';
  let tenant = null;

  for (const phoneNumber of [fromNumber, toNumber]) {
    if (!phoneNumber) continue;
    tenant = await adminCredentialsService.getTwilioCredentialsByPhoneNumber(phoneNumber);
    if (tenant?.twilioAuthToken) {
      authToken = tenant.twilioAuthToken;
      break;
    }
  }

  if (!authToken && queryUserId) {
    tenant = await adminCredentialsService.getTwilioCredentialsByUserId(queryUserId);
    if (tenant?.twilioAuthToken) {
      authToken = tenant.twilioAuthToken;
    }
  }

  if (!authToken && callSid) {
    const call = await Call.findOne({ callSid }).select('user providerData.from').lean();
    const callUserId = call?.user ? String(call.user) : '';
    if (callUserId) {
      tenant = await adminCredentialsService.getTwilioCredentialsByUserId(callUserId);
      if (tenant?.twilioAuthToken) {
        authToken = tenant.twilioAuthToken;
      }
    }
  }

  return { authToken, fromNumber: fromNumber || toNumber, tenant };
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
    const { authToken: tenantAuthToken, fromNumber, tenant } = await resolveAuthContext(req);
    const authToken = tenantAuthToken || String(process.env.TWILIO_AUTH_TOKEN || '').trim();

    if (!authToken) {
      logger.error('Twilio auth token is not configured');
      return res.status(500).send('Twilio auth configuration missing');
    }

    const url = resolveWebhookUrl(req);
    const params = req.body || {};

    const isValid = twilio.validateRequest(authToken, twilioSignature, url, params);

    if (!isValid) {
      logger.warn('Invalid Twilio signature', {
        ...buildWebhookDebugContext(req, url),
        hasAuthToken: Boolean(authToken),
      });
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
