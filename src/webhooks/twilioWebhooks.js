import twilio from 'twilio';
import axios from 'axios';

import BroadcastCall from '../models/BroadcastCall.js';
import Broadcast from '../models/Broadcast.js';
import OptOut from '../models/OptOut.js';

import logger from '../utils/logger.js';
import { emitCallUpdate } from '../sockets/unifiedSocket.js';

const { twiml: { VoiceResponse } } = twilio;

/**
 * Utility: Validate that Twilio can access the audio
 */
async function isAudioReachable(url) {
  try {
    const res = await axios.head(url, {
      timeout: 3000,
      validateStatus: status => status >= 200 && status < 400
    });
    return true;
  } catch (err) {
    logger.error('Audio URL unreachable:', {
      url,
      error: err.message
    });
    return false;
  }
}

class TwilioWebhooks {

  /**
   * ==========================================
   * Generate TwiML for Broadcast Call
   * GET /webhook/broadcast/twiml
   * ==========================================
   */
  async getBroadcastTwiML(req, res) {
    try {
      const { audioUrl, disclaimer, messageText, voice, language } = req.query;

      // 🔥 CRITICAL FIX: Set proper headers for Twilio
      res.setHeader('Content-Type', 'text/xml');
      res.setHeader('Cache-Control', 'no-cache');

      // 🔥 CRITICAL FIX: Support both audio URL and text-to-speech
      let audioSection = '';
      
      if (audioUrl && audioUrl !== 'null') {
        // Use pre-recorded audio
        try {
          const audioOk = await isAudioReachable(audioUrl);
          if (!audioOk) {
            logger.warn('Audio URL verification failed (might still work for Twilio)', { audioUrl });
          }
        } catch (checkErr) {
          logger.warn('Audio check skipped due to error', { error: checkErr.message });
        }
        
        audioSection = `<Play>${audioUrl}</Play>`;
        logger.info('Using pre-recorded audio for broadcast');
      } else if (messageText) {
        // Use text-to-speech fallback
        const voiceConfig = voice || 'alice';
        const langConfig = language || 'en-IN';
        audioSection = `<Say voice="${voiceConfig}" language="${langConfig}">${messageText}</Say>`;
        logger.info('Using text-to-speech fallback for broadcast');
      } else {
        logger.error('Missing both audioUrl and messageText in TwiML request');
        const errorTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Invalid broadcast configuration</Say>
  <Hangup/>
</Response>`;
        return res.send(errorTwiML);
      }

      // 🔥 CRITICAL FIX: Proper TwiML with valid structure
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-IN">
    ${disclaimer || 'This is an automated call'}
  </Say>

  <Gather numDigits="1"
          timeout="3"
          action="${process.env.BASE_URL}/webhook/broadcast/keypress"
          method="POST">
    <Say voice="alice" language="en-IN">
      Press 9 to stop receiving these calls
    </Say>
  </Gather>

  ${audioSection}

  <Hangup/>
</Response>`;

      logger.info('TwiML generated successfully', { audioUrl, hasDisclaimer: !!disclaimer });
      res.send(twiml);

    } catch (error) {
      logger.error('TwiML generation failed', {
        message: error.message,
        stack: error.stack
      });

      // 🔥 CRITICAL FIX: Error response with proper headers
      res.setHeader('Content-Type', 'text/xml');
      const errorTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">System error occurred</Say>
  <Hangup/>
</Response>`;
      res.send(errorTwiML);
    }
  }

  /**
   * ==========================================
   * Handle Call Status Updates (CRITICAL)
   * POST /webhook/broadcast/:callId/status
   * ==========================================
   */
  async handleCallStatus(req, res) {
    try {
      const {
        CallSid,
        CallStatus,
        CallDuration,
        AnsweredBy,
        ErrorCode,
        ErrorMessage
      } = req.body;

      const { callId } = req.params;

      let call = await BroadcastCall.findOne({ callSid: CallSid });

      // Fallback: Try looking up by database ID (handling race conditions)
      if (!call && callId) {
        try {
          call = await BroadcastCall.findById(callId);
          if (call) {
            logger.info('Found call by ID (race condition handled)', { callId, CallSid });

            // Ensure CallSid is saved for future lookups
            if (!call.callSid) {
              call.callSid = CallSid;
              await call.save();
            }
          }
        } catch (err) {
          logger.warn('Invalid callId in status callback', { callId });
        }
      }

      if (!call) {
        logger.warn('Status update for unknown call', { CallSid, callId });
        return res.sendStatus(404);
      }

      const statusMap = {
        initiated: 'calling',
        ringing: 'ringing',
        'in-progress': 'answered',
        completed: 'completed',
        busy: 'failed',
        'no-answer': 'failed',
        failed: 'failed',
        canceled: 'cancelled'
      };

      call.status = statusMap[CallStatus] || CallStatus;

      if (CallStatus === 'completed') {
        call.duration = parseInt(CallDuration, 10) || 0;
        call.endTime = new Date();
      }

      if (AnsweredBy) {
        call.metadata = {
          ...(call.metadata || {}),
          answeredBy: AnsweredBy
        };
      }

      if (ErrorCode || ErrorMessage) {
        call.metadata = {
          ...(call.metadata || {}),
          errorCode: ErrorCode,
          errorMessage: ErrorMessage
        };
      }

      await call.save();

      // 🔥 REAL-TIME FRONTEND UPDATE
      emitCallUpdate(call.broadcast.toString(), {
        callId: call._id,
        callSid: CallSid,
        phone: call.contact.phone,
        status: call.status,
        duration: call.duration || 0
      });

      // 🔥 Update broadcast aggregate stats
      const broadcast = await Broadcast.findById(call.broadcast);
      if (broadcast) {
        await this.updateBroadcastStats(broadcast);
      }

      res.sendStatus(200);

    } catch (error) {
      logger.error('Call status webhook failed', {
        message: error.message,
        stack: error.stack
      });
      res.sendStatus(500);
    }
  }

  /**
   * ==========================================
   * Update Broadcast Statistics
   * ==========================================
   */
  async updateBroadcastStats(broadcast) {
    const stats = await BroadcastCall.aggregate([
      { $match: { broadcast: broadcast._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const statMap = {};
    stats.forEach(s => statMap[s._id] = s.count);

    broadcast.stats = {
      total: broadcast.stats.total,
      queued: statMap.queued || 0,
      calling: statMap.calling || 0,
      answered: statMap.answered || 0,
      completed: statMap.completed || 0,
      failed: statMap.failed || 0
    };

    await broadcast.save();
  }

  /**
   * ==========================================
   * Handle Keypress (Opt-Out)
   * POST /webhook/broadcast/keypress
   * ==========================================
   */
  async handleKeypress(req, res) {
    try {
      const { CallSid, Digits } = req.body;

      const call = await BroadcastCall.findOne({ callSid: CallSid });
      if (!call) return res.sendStatus(404);

      const response = new VoiceResponse();

      if (Digits === '9') {
        await call.markOptedOut();

        await OptOut.findOneAndUpdate(
          { phone: call.contact.phone },
          {
            phone: call.contact.phone,
            optedOutAt: new Date(),
            source: 'broadcast_keypress'
          },
          { upsert: true }
        );

        response.say(
          { voice: 'alice', language: 'en-IN' },
          'You will no longer receive these calls. Thank you.'
        );
      } else {
        response.say('Invalid option.');
      }

      response.hangup();
      res.type('text/xml').send(response.toString());

    } catch (error) {
      logger.error('Keypress webhook failed', {
        message: error.message,
        stack: error.stack
      });
      res.sendStatus(500);
    }
  }
}

export default new TwilioWebhooks();
