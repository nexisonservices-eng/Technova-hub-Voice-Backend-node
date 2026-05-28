import express from 'express';
import BookingNotificationLog from '../models/BookingNotificationLog.js';
import logger from '../utils/logger.js';

const router = express.Router();

const trimOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

const requireInternalApiKey = (req, res, next) => {
  const expected = trimOrNull(
    process.env.WHATSAPP_BACKEND_INTERNAL_API_KEY ||
    process.env.INTERNAL_API_KEY ||
    process.env.ADMIN_INTERNAL_API_KEY
  );
  const provided = trimOrNull(req.headers['x-internal-api-key']);

  if (!expected) {
    return res.status(503).json({
      success: false,
      error: 'Internal IVR endpoint is not configured'
    });
  }

  if (!provided || provided !== expected) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized internal request'
    });
  }

  return next();
};

const normalizeStatus = (status) => {
  const normalized = String(status || '').trim().toLowerCase();
  if (['sent', 'delivered', 'read', 'failed'].includes(normalized)) {
    return normalized;
  }
  return '';
};

router.post('/notification-status', requireInternalApiKey, async (req, res) => {
  try {
    const providerMessageId = trimOrNull(req.body?.providerMessageId || req.body?.messageId);
    const status = normalizeStatus(req.body?.status);
    const errorMessage = trimOrNull(req.body?.errorMessage || req.body?.error || '');
    const raw = req.body?.raw || req.body?.statusData || {};

    if (!providerMessageId || !status) {
      return res.status(400).json({
        success: false,
        error: 'providerMessageId and valid status are required'
      });
    }

    const update = {
      status,
      errorMessage: status === 'failed' ? errorMessage || 'WhatsApp delivery failed' : '',
      updatedAt: new Date()
    };

    if (raw && typeof raw === 'object') {
      update['payload.deliveryStatus'] = raw;
    }

    const notification = await BookingNotificationLog.findOneAndUpdate(
      { providerMessageId },
      { $set: update },
      { new: true }
    );

    if (!notification) {
      logger.info(`WhatsApp IVR status ignored; no booking notification for ${providerMessageId}`);
      return res.json({
        success: true,
        matched: false
      });
    }

    return res.json({
      success: true,
      matched: true,
      status: notification.status
    });
  } catch (error) {
    logger.error('Failed to update IVR WhatsApp notification status:', error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to update notification status'
    });
  }
});

export default router;
