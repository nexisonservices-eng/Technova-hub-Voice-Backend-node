import twilio from 'twilio';
import logger from '../utils/logger.js';

class TelephonyService {
  createClient(twilioContext) {
    if (!twilioContext?.twilioAccountSid || !twilioContext?.twilioAuthToken) {
      throw new Error('Twilio credentials are missing for this user');
    }
    return twilio(twilioContext.twilioAccountSid, twilioContext.twilioAuthToken);
  }

  generateIncomingTwiML(websocketUrl, greeting = null) {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    if (greeting) {
      response.say({ voice: 'alice', language: 'en-US' }, greeting);
    }

    const connect = response.connect();
    connect.stream({ url: websocketUrl, track: 'both_tracks' });
    return response.toString();
  }

  async makeCall(to, twilioContext, from = null, webhookUrl) {
    const client = this.createClient(twilioContext);
    const call = await client.calls.create({
      to,
      from: from || twilioContext.twilioPhoneNumber,
      url: webhookUrl || `${process.env.BASE_URL}/webhook/incoming`,
      statusCallback: `${process.env.BASE_URL}/webhook/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    logger.info(`Call initiated: ${call.sid}`);
    return { success: true, callSid: call.sid, status: call.status, provider: 'twilio' };
  }

  async initiateOutboundCall(phoneNumber, twilioContext, scenario = null) {
    const client = this.createClient(twilioContext);
    const webhookUrl = `${process.env.BASE_URL}/webhook/incoming`;
    const call = await client.calls.create({
      to: phoneNumber,
      from: twilioContext.twilioPhoneNumber,
      url: webhookUrl,
      statusCallback: `${process.env.BASE_URL}/webhook/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: process.env.RECORD_CALLS === 'true' ? 'record-from-answer' : false,
      recordingStatusCallback: `${process.env.BASE_URL}/webhook/recording`
    });

    logger.info(`Outbound call initiated: ${call.sid} to ${phoneNumber}`);
    return {
      success: true,
      callSid: call.sid,
      status: call.status,
      phoneNumber,
      scenario,
      provider: 'twilio'
    };
  }

  async endCall(callSid, twilioContext) {
    const client = this.createClient(twilioContext);
    await client.calls(callSid).update({ status: 'completed' });
    logger.info(`Call ended: ${callSid}`);
    return { success: true };
  }

  async getCallDetails(callSid, twilioContext) {
    const client = this.createClient(twilioContext);
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
  }

  async startRecording(callSid, twilioContext) {
    const client = this.createClient(twilioContext);
    const recording = await client.calls(callSid).recordings.create();
    logger.info(`Recording started: ${recording.sid}`);
    return recording;
  }

  getProviderInfo(twilioContext = {}) {
    return {
      provider: 'twilio',
      phoneNumber: twilioContext.twilioPhoneNumber || null
    };
  }
}

export default new TelephonyService();
