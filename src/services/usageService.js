import axios from 'axios';
import logger from '../utils/logger.js';

const ADMIN_BASE_URL =
  process.env.ADMIN_BACKEND_URL ||
  process.env.ADMIN_API_BASE_URL ||
  process.env.ADMIN_SERVICE_URL ||
  '';

const ADMIN_USAGE_ENDPOINT = process.env.ADMIN_USAGE_ENDPOINT || '/internal/usage/record';
const ADMIN_INTERNAL_API_KEY = process.env.ADMIN_INTERNAL_API_KEY || process.env.INTERNAL_API_KEY || '';

export const reportUsage = async ({ companyId, userId, usageType, count = 1 }) => {
  if (!ADMIN_BASE_URL || !ADMIN_INTERNAL_API_KEY || !companyId) return;
  try {
    await axios.post(
      `${ADMIN_BASE_URL}${ADMIN_USAGE_ENDPOINT}`,
      { companyId, userId, usageType, count },
      { headers: { 'x-internal-api-key': ADMIN_INTERNAL_API_KEY }, timeout: 10000 }
    );
  } catch (error) {
    logger.warn('Failed to report usage', { error: error.message });
  }
};
