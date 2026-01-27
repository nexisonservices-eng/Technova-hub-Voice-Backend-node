import twilio from 'twilio';
import logger from '../utils/logger.js';

const { twiml: { VoiceResponse } } = twilio;

class TwilioVoiceService {
  constructor() {
    this.client = null;
  }

  getClient() {
    if (!this.client) {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;

      if (!sid || !token) {
        throw new Error('Twilio credentials are missing');
      }

      this.client = twilio(sid, token);
      logger.info('✓ Twilio Voice Service Initialized');
    }

    return this.client;
  }

  /**
   * ==========================================
   * Initiate outbound broadcast call
   * ==========================================
   */
  async makeVoiceBroadcastCall(params) {
    const { to, audioUrl, disclaimerText, callbackUrl } = params;

    if (!to || !audioUrl) {
      throw new Error('Missing required params: to or audioUrl');
    }

    // ✅ ALWAYS use webhook-based TwiML (no inline TwiML)
    const twimlUrl =
      `${process.env.BASE_URL}/webhook/broadcast/twiml` +
      `?audioUrl=${encodeURIComponent(audioUrl)}` +
      `&disclaimer=${encodeURIComponent(disclaimerText || '')}`;

    try {
      const client = this.getClient();
      const call = await client.calls.create({
        to,
        from: process.env.TWILIO_PHONE_NUMBER,

        url: twimlUrl,
        method: 'GET',

        statusCallback: callbackUrl,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: [
          'initiated',
          'ringing',
          'answered',
          'completed'
        ],

        // ✅ IMPORTANT (safe defaults)
        timeout: 25,
        machineDetection: 'Enable',
        machineDetectionTimeout: 4000,
        record: false
      });

      logger.info('📞 Broadcast call started', {
        sid: call.sid,
        to
      });

      return {
        sid: call.sid,
        status: call.status
      };

    } catch (error) {
      logger.error('❌ Twilio call creation failed', {
        to,
        message: error.message,
        code: error.code
      });
      throw error;
    }
  }

  /**
   * ==========================================
   * Handle answering machine detection
   * (called from status webhook if needed)
   * ==========================================
   */
  async handleAnsweringMachine(callSid) {
    try {
      const client = this.getClient();
      await client.calls(callSid).update({
        twiml: `
          <Response>
            <Say voice="alice">
              Hello, this is an automated message. We'll call back later.
            </Say>
          </Response>
        `
      });

      logger.info('📞 Answering machine detected, left message', { callSid });
    } catch (error) {
      logger.error('❌ Failed to handle answering machine', error);
      throw error;
    }
  }

  /**
   * ==========================================
   * End an active call
   * ==========================================
   */
  async endCall(callSid) {
    try {
      const client = this.getClient();
      await client.calls(callSid).update({
        status: 'completed'
      });

      logger.info('📴 Call ended', { callSid });

    } catch (error) {
      logger.error('❌ Failed to end call', {
        callSid,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * ==========================================
   * Fetch call details from Twilio
   * ==========================================
   */
  async getCallDetails(callSid) {
    try {
      const client = this.getClient();
      const call = await client.calls(callSid).fetch();

      return {
        sid: call.sid,
        status: call.status,
        duration: Number(call.duration) || 0,
        from: call.from,
        to: call.to,
        startTime: call.startTime,
        endTime: call.endTime,
        answeredBy: call.answeredBy,
        price: call.price,
        priceUnit: call.priceUnit
      };

    } catch (error) {
      logger.error('❌ Failed to fetch call details', {
        callSid,
        error: error.message
      });
      throw error;
    }
  }
}

export default new TwilioVoiceService();
