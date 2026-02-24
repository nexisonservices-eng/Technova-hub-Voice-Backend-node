import twilio from 'twilio';
import logger from '../utils/logger.js';

class TwilioVoiceService {
  createClient(twilioContext) {
    if (!twilioContext?.twilioAccountSid || !twilioContext?.twilioAuthToken) {
      throw new Error('Twilio credentials are missing for this user');
    }
    return twilio(twilioContext.twilioAccountSid, twilioContext.twilioAuthToken);
  }

  async makeVoiceBroadcastCall(params, twilioContext) {
    const {
      to,
      audioUrl,
      disclaimerText,
      callbackUrl,
      messageText,
      voice,
      language,
      enableOptOut
    } = params;
    if (!to) throw new Error('Missing required param: to');
    const baseUrl = String(process.env.BASE_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      throw new Error('Missing BASE_URL for Twilio webhook callbacks');
    }

    const twimlParams = new URLSearchParams();
    twimlParams.append('disclaimer', disclaimerText || '');
    if (audioUrl && audioUrl !== 'null') twimlParams.append('audioUrl', audioUrl);
    if (messageText) {
      twimlParams.append('messageText', messageText);
      twimlParams.append('voice', voice || 'alice');
      twimlParams.append('language', language || 'en-IN');
    }
    if (typeof enableOptOut !== 'undefined') {
      twimlParams.append('enableOptOut', String(enableOptOut));
    }

    const twimlUrl = `${baseUrl}/webhook/broadcast/twiml?${twimlParams.toString()}`;
    const normalizedStatusCallback = String(callbackUrl || '').replace(/([^:]\/)\/+/g, '$1');
    const client = this.createClient(twilioContext);
    const call = await client.calls.create({
      to,
      from: twilioContext.twilioPhoneNumber,
      url: twimlUrl,
      method: 'POST',
      statusCallback: normalizedStatusCallback,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: 25,
      machineDetection: 'Enable',
      machineDetectionTimeout: 4000,
      record: false
    });

    logger.info('Broadcast call started', { sid: call.sid, to });
    return { sid: call.sid, status: call.status };
  }

  async handleAnsweringMachine(callSid, twilioContext) {
    const client = this.createClient(twilioContext);
    await client.calls(callSid).update({
      twiml: '<Response><Say voice="alice">Hello, this is an automated message. We will call back later.</Say></Response>'
    });
    logger.info('Answering machine detected, message left', { callSid });
  }

  async endCall(callSid, twilioContext) {
    const client = this.createClient(twilioContext);
    await client.calls(callSid).update({ status: 'completed' });
    logger.info('Call ended', { callSid });
  }

  async getCallDetails(callSid, twilioContext) {
    const client = this.createClient(twilioContext);
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
  }
}

export default new TwilioVoiceService();
