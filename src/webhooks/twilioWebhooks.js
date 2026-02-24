import twilio from 'twilio';

import BroadcastCall from '../models/BroadcastCall.js';
import Broadcast from '../models/Broadcast.js';
import OptOut from '../models/OptOut.js';

import logger from '../utils/logger.js';
import { emitCallUpdate } from '../sockets/unifiedSocket.js';

const { twiml: { VoiceResponse } } = twilio;

function isPublicMediaUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const host = (parsed.hostname || '').toLowerCase();
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local')
    ) {
      return false;
    }
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

class TwilioWebhooks {
  /**
   * ==========================================
   * Generate TwiML for Broadcast Call
   * POST /webhook/broadcast/twiml
   * ==========================================
   */
  async getBroadcastTwiML(req, res) {
    try {
      const {
        audioUrl,
        disclaimer,
        messageText,
        voice,
        language,
        enableOptOut
      } = req.query;
      const shouldOfferOptOut = String(enableOptOut ?? 'true').toLowerCase() !== 'false';

      const response = new VoiceResponse();
      response.say(
        { voice: 'alice', language: 'en-IN' },
        disclaimer || 'This is an automated call'
      );

      if (audioUrl && audioUrl !== 'null' && isPublicMediaUrl(audioUrl)) {
        response.play(audioUrl);
        logger.info('Using pre-recorded audio for broadcast');
      } else if (audioUrl && audioUrl !== 'null') {
        logger.warn('Ignoring non-public or invalid media URL for broadcast', { audioUrl });
        response.say(
          { voice: voice || 'alice', language: language || 'en-IN' },
          messageText || 'Broadcast audio is currently unavailable'
        );
      } else if (messageText) {
        response.say(
          { voice: voice || 'alice', language: language || 'en-IN' },
          messageText
        );
        logger.info('Using text-to-speech fallback for broadcast');
      } else {
        response.say({ voice: 'alice', language: 'en-IN' }, 'Invalid broadcast configuration');
      }

      if (shouldOfferOptOut) {
        // Gather only after the message/audio is played so playback is not interrupted.
        const gather = response.gather({
          numDigits: 1,
          timeout: 5,
          action: `${process.env.BASE_URL}/webhook/broadcast/keypress`,
          method: 'POST'
        });
        gather.say({ voice: 'alice', language: 'en-IN' }, 'Press 9 to stop receiving these calls.');
      }

      // If no key is pressed, Twilio continues to the next verb and ends the call.
      response.say({ voice: 'alice', language: 'en-IN' }, 'Thank you. Goodbye.');
      response.hangup();

      logger.info('TwiML generated successfully', { audioUrl, hasDisclaimer: !!disclaimer });
      return res.status(200).type('text/xml').send(response.toString());

    } catch (error) {
      logger.error('TwiML generation failed', {
        message: error.message,
        stack: error.stack
      });

      const response = new VoiceResponse();
      response.say({ voice: 'alice', language: 'en-IN' }, 'System error occurred');
      response.hangup();
      return res.status(200).type('text/xml').send(response.toString());
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

      // Do not return 404 to Twilio callbacks; acknowledge to prevent webhook errors.
      if (!call) {
        logger.warn('Status update for unknown call', { CallSid, callId });
        return res.sendStatus(200);
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

      emitCallUpdate(call.broadcast.toString(), {
        callId: call._id,
        callSid: CallSid,
        phone: call.contact.phone,
        status: call.status,
        duration: call.duration || 0
      });

      const broadcast = await Broadcast.findById(call.broadcast);
      if (broadcast) {
        await this.updateBroadcastStats(broadcast);
      }

      return res.sendStatus(200);

    } catch (error) {
      logger.error('Call status webhook failed', {
        message: error.message,
        stack: error.stack
      });
      // Always ACK callback to avoid Twilio webhook retry/failure noise.
      return res.sendStatus(200);
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
      if (!call) {
        const response = new VoiceResponse();
        response.say({ voice: 'alice', language: 'en-IN' }, 'Thank you.');
        response.hangup();
        return res.status(200).type('text/xml').send(response.toString());
      }

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
        response.say({ voice: 'alice', language: 'en-IN' }, 'Invalid option.');
      }

      response.hangup();
      return res.status(200).type('text/xml').send(response.toString());

    } catch (error) {
      logger.error('Keypress webhook failed', {
        message: error.message,
        stack: error.stack
      });
      const response = new VoiceResponse();
      response.say({ voice: 'alice', language: 'en-IN' }, 'Thank you.');
      response.hangup();
      return res.status(200).type('text/xml').send(response.toString());
    }
  }
}

export default new TwilioWebhooks();
