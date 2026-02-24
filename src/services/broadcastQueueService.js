import logger from '../utils/logger.js';
import Broadcast from '../models/Broadcast.js';
import BroadcastCall from '../models/BroadcastCall.js';
import twilioVoiceService from './twilioVoiceService.js';
import aiAssistantService from './aiAssistantService.js';
import adminCredentialsService from './adminCredentialsService.js';
import { emitBroadcastUpdate, emitCallUpdate, emitBroadcastListUpdate } from "../sockets/unifiedSocket.js";

class BroadcastQueueService {
  constructor() {
    this.activeBroadcasts = new Map(); // broadcastId -> { interval }
    this.POLL_INTERVAL = 5000; // 5 seconds
  }

  /**
   * Start processing broadcast queue
   */
  startBroadcast(broadcastId) {
    if (this.activeBroadcasts.has(broadcastId)) {
      logger.warn(`Broadcast ${broadcastId} already active`);
      return;
    }

    logger.info(`Starting queue processor for broadcast: ${broadcastId}`);

    const interval = setInterval(async () => {
      await this._processBroadcastQueue(broadcastId);
    }, this.POLL_INTERVAL);

    this.activeBroadcasts.set(broadcastId, {
      interval
    });
  }

  /**
   * Stop processing broadcast
   */
  stopBroadcast(broadcastId) {
    const broadcastData = this.activeBroadcasts.get(broadcastId);

    if (broadcastData) {
      clearInterval(broadcastData.interval);
      this.activeBroadcasts.delete(broadcastId);
      logger.info(`Stopped queue processor for broadcast: ${broadcastId}`);
    }
  }

  /**
   * Main queue processing logic
   */
  async _processBroadcastQueue(broadcastId) {
    try {
      const broadcast = await Broadcast.findById(broadcastId);

      if (!broadcast) {
        this.stopBroadcast(broadcastId);
        return;
      }

      // Completed or cancelled
      if (['completed', 'cancelled'].includes(broadcast.status)) {
        this.stopBroadcast(broadcastId);
        return;
      }

      // Transition to in_progress (Handle both 'queued' and stuck 'draft')
      if (broadcast.status === 'queued' || broadcast.status === 'draft') {
        logger.info(`Broadcast ${broadcastId} transitioning from ${broadcast.status} to in_progress`);
        await broadcast.updateStatus('in_progress');
        emitBroadcastListUpdate();
      }

      // Count active calls
      const activeCalls = await BroadcastCall.countDocuments({
        broadcast: broadcastId,
        userId: broadcast.createdBy,
        status: { $in: ['calling', 'ringing', 'in_progress'] }
      });

      const maxConcurrent = broadcast.config.maxConcurrent || 50;
      const availableSlots = maxConcurrent - activeCalls;

      if (availableSlots <= 0) {
        logger.debug(
          `Broadcast ${broadcastId}: Max concurrency reached (${activeCalls}/${maxConcurrent})`
        );
        return;
      }

      // Fetch calls ready to be made
      const callsToMake = await this._getNextCalls(
        broadcastId,
        availableSlots
      );

      if (callsToMake.length === 0) {
        const pendingCalls = await BroadcastCall.countDocuments({
          broadcast: broadcastId,
          userId: broadcast.createdBy,
          status: { $in: ['queued', 'calling', 'ringing', 'in_progress'] }
        });

        if (pendingCalls === 0) {
          logger.info(`Broadcast ${broadcastId} completed`);
          logger.info(`Broadcast ${broadcastId} completed`);
          await broadcast.updateStatus('completed');
          emitBroadcastListUpdate();
          this.stopBroadcast(broadcastId);
        }

        return;
      }

      logger.info(
        `Broadcast ${broadcastId}: Initiating ${callsToMake.length} calls (${activeCalls + callsToMake.length}/${maxConcurrent})`
      );

      await Promise.allSettled(
        callsToMake.map(call =>
          this._initiateCall(call, broadcast)
        )
      );

      emitBroadcastUpdate(broadcastId, {
        status: broadcast.status,
        stats: broadcast.stats,
        activeCalls: activeCalls + callsToMake.length
      });
    } catch (error) {
      logger.error(
        `Error processing broadcast queue ${broadcastId}:`,
        error
      );
    }
  }

  /**
   * Get next batch of calls
   */
  async _getNextCalls(broadcastId, limit) {
    const freshCalls = await BroadcastCall.find({
      broadcast: broadcastId,
      userId: { $exists: true },
      status: 'queued',
      attempts: 0
    })
      .limit(limit)
      .lean();

    if (freshCalls.length >= limit) {
      return freshCalls;
    }

    const retryCalls = await BroadcastCall.getRetryableCalls(broadcastId);

    return [
      ...freshCalls,
      ...retryCalls.slice(0, limit - freshCalls.length)
    ];
  }

  /**
   * Initiate single call
   */
  async _initiateCall(callDoc, broadcast) {
    try {
      const call = await BroadcastCall.findOne({ _id: callDoc._id, userId: broadcast.createdBy });

      if (!call) {
        logger.error(`Call ${callDoc._id} not found`);
        return;
      }

      // 🔥 EMIT: Call queued event
      emitCallUpdate(broadcast._id.toString(), {
        callId: call._id,
        phone: call.contact.phone,
        status: 'calling',
        duration: 0
      });

      // DND check
      if (broadcast.config.compliance.dndRespect) {
        const dndStatus = await this._checkDND(call.contact.phone);

        if (dndStatus === 'blocked') {
          call.dndStatus = 'blocked';
          call.status = 'failed';
          await call.save();
          await broadcast.incrementStat('failed');

          // 🔥 EMIT: Call failed due to DND
          emitCallUpdate(broadcast._id.toString(), {
            callId: call._id,
            phone: call.contact.phone,
            status: 'failed',
            duration: 0
          });
          return;
        }
      }

      // Opt-out check
      if (await this._isOptedOut(call.contact.phone)) {
        await call.markOptedOut();
        await broadcast.incrementStat('opted_out');

        // 🔥 EMIT: Call opted out
        emitCallUpdate(broadcast._id.toString(), {
          callId: call._id,
          phone: call.contact.phone,
          status: 'opted_out',
          duration: 0
        });
        return;
      }

      const credentials = await adminCredentialsService.getTwilioCredentialsByUserId(String(broadcast.createdBy));
      if (!credentials?.twilioAccountSid || !credentials?.twilioAuthToken || !credentials?.twilioPhoneNumber) {
        throw new Error('Twilio credentials missing for broadcast owner');
      }
      const baseUrl = String(process.env.BASE_URL || '').replace(/\/$/, '');
      if (!baseUrl) {
        throw new Error('Missing BASE_URL for Twilio webhook callbacks');
      }

      const twilioResponse = await twilioVoiceService.makeVoiceBroadcastCall({
          to: call.contact.phone,
          audioUrl: call.personalizedMessage.audioUrl,
          messageText: call.personalizedMessage.text,
          voice: broadcast.voice.voiceId,
          language: broadcast.voice.language,
          disclaimerText:
            broadcast.config.compliance.disclaimerText,
          callbackUrl: `${baseUrl}/webhook/broadcast/${call._id}/status`
        }, {
          twilioAccountSid: credentials.twilioAccountSid,
          twilioAuthToken: credentials.twilioAuthToken,
          twilioPhoneNumber: credentials.twilioPhoneNumber
        });

      await call.markCalling(twilioResponse.sid);
      await broadcast.incrementStat('calling');

      logger.info(
        `Call initiated: ${call._id} -> ${call.contact.phone} (${twilioResponse.sid})`
      );

      // 🔥 EMIT: Call initiated successfully
      emitCallUpdate(broadcast._id.toString(), {
        callId: call._id,
        callSid: twilioResponse.sid,
        phone: call.contact.phone,
        status: 'calling',
        duration: 0
      });

    } catch (error) {
      logger.error(
        `Failed to initiate call ${callDoc._id}:`,
        error
      );

      const call = await BroadcastCall.findById(callDoc._id);
      if (call) {
        await call.markFailed(
          error.code || 500,
          error.message,
          true
        );

        // 🔥 EMIT: Call failed due to error
        emitCallUpdate(call.broadcast.toString(), {
          callId: call._id,
          phone: call.contact.phone,
          status: 'failed',
          duration: 0
        });
      }
    }
  }

  /**
   * Determine if AI fallback should be triggered
   */
  async _shouldTriggerAIFallback(call, broadcast, error) {
    try {
      // Check if AI service is available
      const healthCheck = await aiAssistantService.constructor.checkHealth?.();
      if (healthCheck?.status !== 'ok') {
        return false;
      }

      // Check broadcast configuration for AI fallback
      if (!broadcast.config.enableAIFallback) {
        return false;
      }

      // Check failure reasons that should trigger AI
      const aiFallbackReasons = [
        'no-answer',
        'busy',
        'failed',
        'timeout'
      ];

      const failureReason = error.code || error.message || '';
      const shouldFallback = aiFallbackReasons.some(reason => 
        failureReason.toLowerCase().includes(reason)
      );

      // Check attempt count (don't fallback on first attempt)
      if (call.attempts < 1) {
        return false;
      }

      // Check if AI fallback hasn't been used yet
      if (call.providerData?.aiFallback?.triggered) {
        return false;
      }

      return shouldFallback;
    } catch (error) {
      logger.error('Error checking AI fallback conditions:', error);
      return false;
    }
  }

  /**
   * Check opt-out list
   */
  async _isOptedOut(phoneNumber) {
    // TODO: Implement opt-out check
    return false;
  }

  /**
   * Check if number is on DND registry
   */
  async _checkDND(phoneNumber) {
    // TODO: Implement DND registry check
    return 'allowed';
  }

  /**
   * Get active broadcasts count
   */
  getActiveBroadcastsCount() {
    return this.activeBroadcasts.size;
  }
}

export default new BroadcastQueueService();
