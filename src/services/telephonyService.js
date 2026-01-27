import twilio from 'twilio';
import axios from 'axios';
import logger from '../utils/logger.js';

class TelephonyService {
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
      logger.info('✓ Twilio Telephony Service Initialized');
    }

    return this.client;
  }

  /* =========================
     Incoming Call – TwiML
  ========================== */
  generateIncomingTwiML(websocketUrl, greeting = null) {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    if (greeting) {
      response.say(
        {
          voice: 'alice',
          language: 'en-US'
        },
        greeting
      );
    }

    const connect = response.connect();
    connect.stream({
      url: websocketUrl,
      track: 'both_tracks'
    });

    return response.toString();
  }

  /* =========================
     Outbound Call
  ========================== */
  async makeCall(to, from = null, webhookUrl) {
    try {
      const client = this.getClient();
      const call = await client.calls.create({
        to,
        from: from || process.env.TWILIO_PHONE_NUMBER,
        url: webhookUrl || `${process.env.BASE_URL}/webhook/incoming`,
        statusCallback: `${process.env.BASE_URL}/webhook/status`,
        statusCallbackEvent: [
          'initiated',
          'ringing',
          'answered',
          'completed'
        ]
      });

      logger.info(`📞 Call initiated: ${call.sid}`);

      return {
        success: true,
        callSid: call.sid,
        status: call.status,
        provider: 'twilio'
      };
    } catch (error) {
      logger.error('❌ Twilio call failed', error);
      throw error;
    }
  }

  /* =========================
     Initiate Outbound Call with Enhanced Routing
  ========================== */
  async initiateOutboundCall(phoneNumber, scenario = null) {
    try {
      const client = this.getClient();
      const webhookUrl = `${process.env.BASE_URL}/webhook/incoming`;
      
      const call = await client.calls.create({
        to: phoneNumber,
        from: process.env.TWILIO_PHONE_NUMBER,
        url: webhookUrl,
        statusCallback: `${process.env.BASE_URL}/webhook/status`,
        statusCallbackEvent: [
          'initiated',
          'ringing',
          'answered',
          'completed'
        ],
        record: process.env.RECORD_CALLS === 'true' ? 'record-from-answer' : false,
        recordingStatusCallback: `${process.env.BASE_URL}/webhook/recording`
      });

      logger.info(`📞 Outbound call initiated: ${call.sid} to ${phoneNumber}`);

      return {
        success: true,
        callSid: call.sid,
        status: call.status,
        phoneNumber,
        scenario,
        provider: 'twilio'
      };
    } catch (error) {
      logger.error('❌ Outbound call failed', error);
      throw error;
    }
  }

  /* =========================
     End Call
  ========================== */
  async endCall(callSid) {
    try {
      const client = this.getClient();
      await client.calls(callSid).update({
        status: 'completed'
      });

      logger.info(`📴 Call ended: ${callSid}`);
      return { success: true };
    } catch (error) {
      logger.error(`❌ Failed to end call ${callSid}`, error);
      throw error;
    }
  }

  /* =========================
     Get Call Details
  ========================== */
  async getCallDetails(callSid) {
    try {
      const client = this.getClient();
      const call = await client.calls(callSid).fetch();

      return {
        callSid: call.sid,
        status: call.status,
        duration: call.duration,
        from: call.from,
        to: call.to,
        startTime: call.startTime,
        endTime: call.endTime
      };
    } catch (error) {
      logger.error('❌ Failed to fetch call details', error);
      throw error;
    }
  }

  /* =========================
     Start Recording
  ========================== */
  async startRecording(callSid) {
    try {
      const client = this.getClient();
      const recording = await client
        .calls(callSid)
        .recordings.create();

      logger.info(`🎙 Recording started: ${recording.sid}`);
      return recording;
    } catch (error) {
      logger.error('❌ Failed to start recording', error);
      throw error;
    }
  }

  /* =========================
     Provider Info
  ========================== */
  getProviderInfo() {
    return {
      provider: 'twilio',
      phoneNumber: process.env.TWILIO_PHONE_NUMBER
    };
  }
}

export default new TelephonyService();
