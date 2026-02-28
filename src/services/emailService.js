import logger from '../utils/logger.js';

let cachedTransporter = null;
let nodemailerModulePromise = null;

const toBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
};

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

class EmailService {
  isConfigured() {
    return Boolean(
      process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      process.env.SMTP_FROM
    );
  }

  async getNodemailer() {
    if (!nodemailerModulePromise) {
      nodemailerModulePromise = import('nodemailer')
        .then((mod) => mod.default || mod)
        .catch((error) => {
          logger.error(`Failed to load nodemailer: ${error.message}`);
          throw error;
        });
    }
    return nodemailerModulePromise;
  }

  async getTransporter() {
    if (cachedTransporter) return cachedTransporter;

    if (!this.isConfigured()) {
      throw new Error('SMTP is not configured');
    }

    const nodemailer = await this.getNodemailer();
    const port = toNumber(process.env.SMTP_PORT, 587);
    const secure = toBoolean(process.env.SMTP_SECURE, port === 465);

    cachedTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      pool: true,
      maxConnections: toNumber(process.env.SMTP_MAX_CONNECTIONS, 3),
      maxMessages: toNumber(process.env.SMTP_MAX_MESSAGES, 50)
    });

    return cachedTransporter;
  }

  async sendEmail({ to, subject, text = '', html = '', metadata = {} }) {
    const recipient = String(to || '').trim();
    if (!recipient) {
      return { success: false, skipped: true, reason: 'missing_recipient' };
    }

    if (!this.isConfigured()) {
      logger.warn(`Email send skipped (SMTP not configured). recipient=${recipient}`);
      return { success: false, skipped: true, reason: 'smtp_not_configured' };
    }

    const transporter = await this.getTransporter();
    const mailOptions = {
      from: process.env.SMTP_FROM,
      to: recipient,
      subject: String(subject || 'Notification'),
      text: String(text || ''),
      ...(html ? { html: String(html) } : {}),
      headers: {
        'X-Workflow-CallSid': String(metadata.callSid || ''),
        'X-Workflow-Event': String(metadata.event || '')
      }
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      return {
        success: true,
        messageId: info?.messageId || '',
        accepted: info?.accepted || []
      };
    } catch (error) {
      logger.error(`Email send failed to ${recipient}: ${error.message}`);
      return {
        success: false,
        skipped: false,
        reason: 'send_failed',
        error: error.message
      };
    }
  }
}

export default new EmailService();
