import twilio from 'twilio';
import adminCredentialsService from '../services/adminCredentialsService.js';
import { getUserIdString } from '../utils/authContext.js';

const mask = (value = '') => {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${'*'.repeat(text.length - 4)}${text.slice(-4)}`;
};

const normalizePhone = (value) => {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits}`;
};

export const resolveUserTwilioContext = async (req, res, next) => {
  try {
    const userId = getUserIdString(req);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized: missing user identity' });
    }

    const credentials = await adminCredentialsService.getTwilioCredentialsByUserId(userId);
    if (!credentials?.twilioAccountSid || !credentials?.twilioAuthToken || !credentials?.twilioPhoneNumber) {
      return res.status(400).json({
        message: 'Twilio credentials are not configured for this user'
      });
    }

    req.twilioContext = {
      userId,
      twilioAccountSid: credentials.twilioAccountSid,
      twilioAuthToken: credentials.twilioAuthToken,
      twilioPhoneNumber: normalizePhone(credentials.twilioPhoneNumber),
      createClient: () => twilio(credentials.twilioAccountSid, credentials.twilioAuthToken),
      safe: {
        twilioAccountSid: mask(credentials.twilioAccountSid),
        twilioPhoneNumber: mask(credentials.twilioPhoneNumber)
      }
    };

    return next();
  } catch (error) {
    return res.status(500).json({
      message: 'Failed to resolve user Twilio credentials',
      error: error.message
    });
  }
};
