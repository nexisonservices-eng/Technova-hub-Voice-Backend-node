import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePlanFeature } from '../middleware/planGuard.js';
import outboundLocalController from '../controllers/OutboundController.js';
import campaignSchedulerController from '../controllers/CampaignSchedulerController.js';

const router = express.Router();

const LOCAL_MOBILE_REGEX = /^\+91[6-9][0-9]{9}$/;
const E164_REGEX = /^\+[1-9][0-9]{7,14}$/;

const normalizeTwilioLocalTo = (value = '') => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `+91${digits}`;
  }
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) {
    return `+${digits}`;
  }
  if (String(value || '').trim().startsWith('+')) {
    const e164 = `+${digits}`;
    if (LOCAL_MOBILE_REGEX.test(e164)) {
      return e164;
    }
  }
  return '';
};

const requestBuckets = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;

const rateLimitOutboundLocal = (req, res, next) => {
  const userKey =
    req.user?.userId ||
    req.user?._id ||
    req.ip ||
    'anonymous';
  const now = Date.now();

  const bucket = requestBuckets.get(userKey) || [];
  const active = bucket.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);

  if (active.length >= MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({
      success: false,
      message: 'Rate limit exceeded for outbound call API. Please retry shortly.'
    });
  }

  active.push(now);
  requestBuckets.set(userKey, active);
  return next();
};

const validateQuickCallPayload = (req, res, next) => {
  const provider = String(req.body?.provider || 'exotel').trim().toLowerCase();
  const from =
    provider === 'exotel'
      ? String(req.body?.from || process.env.EXOTEL_NUMBER || '').trim()
      : String(req.body?.from || '').trim();
  const to = String(req.body?.to || '').trim();
  const twilioTo = normalizeTwilioLocalTo(to);

  if (!['exotel', 'twilio'].includes(provider)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid provider. Supported providers are exotel and twilio.'
    });
  }

  if (provider === 'exotel' && !LOCAL_MOBILE_REGEX.test(from)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid From number. Use +91 followed by a valid 10-digit mobile number.'
    });
  }

  if (provider === 'twilio' && from && !E164_REGEX.test(from)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid From number. Use valid E.164 format like +14155550123.'
    });
  }

  if (provider === 'exotel' && !LOCAL_MOBILE_REGEX.test(to)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid To number. Use +91 followed by a valid 10-digit mobile number.'
    });
  }

  if (provider === 'twilio' && !LOCAL_MOBILE_REGEX.test(twilioTo)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid To number. Use a valid supported mobile number (+91XXXXXXXXXX).'
    });
  }

  return next();
};

const validateBulkPayload = (req, res, next) => {
  const provider = String(req.body?.provider || 'exotel').trim().toLowerCase();
  const from = String(req.body?.from || process.env.EXOTEL_NUMBER || '').trim();
  const campaignName = String(req.body?.campaignName || '').trim();
  const customMessage = String(req.body?.customMessage || req.body?.message || '').trim();
  const numbers = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
  const csvData = String(req.body?.csvData || req.body?.csv || '').trim();
  const maxConcurrent = Number(req.body?.maxConcurrent || 5);

  if (!['exotel', 'twilio'].includes(provider)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid provider. Supported providers are exotel and twilio.'
    });
  }

  if (!campaignName || campaignName.length < 3 || campaignName.length > 80) {
    return res.status(400).json({
      success: false,
      message: 'Campaign name must be between 3 and 80 characters.'
    });
  }

  if (!customMessage) {
    return res.status(400).json({
      success: false,
      message: 'Audio message is required for bulk campaign.'
    });
  }

  if (provider === 'exotel' && !LOCAL_MOBILE_REGEX.test(from)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid From number. Use +91 followed by a valid 10-digit mobile number.'
    });
  }

  if (provider === 'twilio' && from && !E164_REGEX.test(from)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid Twilio From number. Use valid E.164 format like +14155550123.'
    });
  }

  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 10) {
    return res.status(400).json({
      success: false,
      message: 'maxConcurrent must be an integer between 1 and 10.'
    });
  }

  if (!numbers.length && !csvData) {
    return res.status(400).json({
      success: false,
      message: 'Provide either numbers array or csvData for bulk campaign.'
    });
  }

  return next();
};

const validateTemplatePayload = (req, res, next) => {
  const name = String(req.body?.name || '').trim();
  const script = String(req.body?.script || '').trim();

  if (!name || name.length < 2 || name.length > 80) {
    return res.status(400).json({
      success: false,
      message: 'Template name must be between 2 and 80 characters.'
    });
  }

  if (!script || script.length > 1000) {
    return res.status(400).json({
      success: false,
      message: 'Template script is required and must be at most 1000 characters.'
    });
  }

  return next();
};

router.use(authenticate);
router.use(rateLimitOutboundLocal);
router.use(requirePlanFeature('outboundVoice'));

router.post('/outbound-local', validateQuickCallPayload, (req, res) =>
  outboundLocalController.quickCall(req, res)
);

router.get('/outbound-local/overview', (req, res) =>
  outboundLocalController.overview(req, res)
);

router.get('/outbound-local/campaigns', (req, res) =>
  outboundLocalController.listCampaigns(req, res)
);

router.get('/outbound-local/schedule', (req, res) =>
  campaignSchedulerController.listSchedules(req, res)
);

router.post('/outbound-local/schedule', (req, res) =>
  campaignSchedulerController.schedule(req, res)
);

router.post('/outbound-local/schedule/:scheduleId/pause', (req, res) =>
  campaignSchedulerController.pause(req, res)
);

router.post('/outbound-local/schedule/:scheduleId/resume', (req, res) =>
  campaignSchedulerController.resume(req, res)
);

router.post('/outbound-local/schedule/bulk-delete', (req, res) =>
  campaignSchedulerController.bulkDelete(req, res)
);

router.post('/outbound-local/campaigns/bulk-delete', (req, res) =>
  outboundLocalController.deleteCampaigns(req, res)
);

router.post('/outbound-local/retry', (req, res) =>
  campaignSchedulerController.retry(req, res)
);

router.post('/outbound-local/abtest', (req, res) =>
  campaignSchedulerController.abtest(req, res)
);

router.get('/outbound-local/numbers/rotate', (req, res) =>
  campaignSchedulerController.rotateNumbers(req, res)
);

router.get('/outbound-local/templates', (req, res) =>
  outboundLocalController.listTemplates(req, res)
);

router.post('/outbound-local/templates', validateTemplatePayload, (req, res) =>
  outboundLocalController.createTemplate(req, res)
);

router.put('/outbound-local/templates/:templateId', validateTemplatePayload, (req, res) =>
  outboundLocalController.updateTemplate(req, res)
);

router.delete('/outbound-local/templates/:templateId', (req, res) =>
  outboundLocalController.deleteTemplate(req, res)
);

router.post('/outbound-local/bulk', validateBulkPayload, (req, res) =>
  outboundLocalController.bulkCampaigns(req, res)
);

export default router;

