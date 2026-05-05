import logger from '../utils/logger.js';
import Broadcast from '../models/Broadcast.js';
import BroadcastCall from '../models/BroadcastCall.js';
import twilioVoiceService from './twilioVoiceService.js';
import aiAssistantService from './aiAssistantService.js';
import adminCredentialsService from './adminCredentialsService.js';
import { emitBatchUpdate, emitBroadcastUpdate, emitCallUpdate, emitBroadcastListUpdate } from '../sockets/unifiedSocket.js';

class BroadcastQueueService {
  constructor() {
    this.activeBroadcasts = new Map();
    this.DEFAULT_DISPATCH_INTERVAL_MS = 1000;
    this.MAX_BATCH_SIZE = 100;
    this.CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
  }

  startBroadcast(broadcastId) {
    const key = String(broadcastId);
    if (this.activeBroadcasts.has(key)) {
      logger.warn(`Broadcast ${key} already active`);
      return;
    }

    logger.info(`Starting queue processor for broadcast: ${key}`);
    this.activeBroadcasts.set(key, {
      timer: null,
      processing: false,
      stopped: false
    });
    this._scheduleNextTick(key, 0);
  }

  stopBroadcast(broadcastId) {
    const key = String(broadcastId);
    const broadcastData = this.activeBroadcasts.get(key);

    if (broadcastData) {
      broadcastData.stopped = true;
      if (broadcastData.timer) {
        clearTimeout(broadcastData.timer);
      }
      this.activeBroadcasts.delete(key);
      logger.info(`Stopped queue processor for broadcast: ${key}`);
    }
  }

  _scheduleNextTick(broadcastId, delayMs = this.DEFAULT_DISPATCH_INTERVAL_MS) {
    const broadcastData = this.activeBroadcasts.get(String(broadcastId));
    if (!broadcastData || broadcastData.stopped) return;

    if (broadcastData.timer) {
      clearTimeout(broadcastData.timer);
    }

    broadcastData.timer = setTimeout(async () => {
      await this._runBroadcastTick(String(broadcastId));
    }, Math.max(0, delayMs));
  }

  async _runBroadcastTick(broadcastId) {
    const broadcastData = this.activeBroadcasts.get(String(broadcastId));
    if (!broadcastData || broadcastData.stopped || broadcastData.processing) return;

    broadcastData.processing = true;
    try {
      const nextDelay = await this._processBroadcastQueue(String(broadcastId));
      if (this.activeBroadcasts.has(String(broadcastId))) {
        this._scheduleNextTick(String(broadcastId), nextDelay);
      }
    } finally {
      const current = this.activeBroadcasts.get(String(broadcastId));
      if (current) {
        current.processing = false;
      }
    }
  }

  async _processBroadcastQueue(broadcastId) {
    try {
      const broadcast = await Broadcast.findById(broadcastId);
      if (!broadcast) {
        this.stopBroadcast(broadcastId);
        return this.DEFAULT_DISPATCH_INTERVAL_MS;
      }

      if (['completed', 'cancelled'].includes(broadcast.status)) {
        this.stopBroadcast(broadcastId);
        return this.DEFAULT_DISPATCH_INTERVAL_MS;
      }

      const dispatchIntervalMs = this._clampNumber(
        broadcast.config?.dispatchIntervalMs,
        this.DEFAULT_DISPATCH_INTERVAL_MS,
        250,
        10000
      );

      if (broadcast.status === 'queued' || broadcast.status === 'draft') {
        logger.info(`Broadcast ${broadcastId} transitioning from ${broadcast.status} to in_progress`);
        await broadcast.updateStatus('in_progress');
        emitBroadcastListUpdate();
      }

      await this._recoverStaleClaims(broadcast);

      const activeCalls = await BroadcastCall.countDocuments({
        broadcast: broadcastId,
        userId: broadcast.createdBy,
        status: { $in: ['claiming', 'calling', 'ringing', 'in_progress', 'answered'] }
      });

      const maxConcurrent = this._clampNumber(broadcast.config?.maxConcurrent, 50, 1, 100);
      const batchSize = this._clampNumber(
        broadcast.config?.batchSize,
        Math.min(25, maxConcurrent),
        1,
        Math.min(this.MAX_BATCH_SIZE, maxConcurrent)
      );
      const availableSlots = maxConcurrent - activeCalls;

      if (availableSlots <= 0) {
        logger.debug(`Broadcast ${broadcastId}: max concurrency reached (${activeCalls}/${maxConcurrent})`);
        return dispatchIntervalMs;
      }

      const callsToMake = await this._claimNextCalls(
        broadcast,
        broadcastId,
        Math.min(availableSlots, batchSize),
        broadcast.config?.maxRetries
      );

      if (callsToMake.length === 0) {
        const pendingCalls = await BroadcastCall.countDocuments({
          broadcast: broadcastId,
          userId: broadcast.createdBy,
          status: { $in: ['queued', 'claiming', 'calling', 'ringing', 'in_progress', 'answered'] }
        });

        if (pendingCalls === 0) {
          logger.info(`Broadcast ${broadcastId} completed`);
          await this._recalculateBroadcastStats(broadcast);
          await broadcast.updateStatus('completed');
          emitBroadcastUpdate(broadcastId, {
            status: broadcast.status,
            stats: broadcast.stats
          });
          emitBroadcastListUpdate();
          this.stopBroadcast(broadcastId);
        }

        return dispatchIntervalMs;
      }

      logger.info(
        `Broadcast ${broadcastId}: initiating ${callsToMake.length} calls (${activeCalls + callsToMake.length}/${maxConcurrent})`
      );

      const results = await Promise.allSettled(
        callsToMake.map((call) => this._initiateCall(call, broadcast))
      );
      const updatedCalls = results
        .filter((result) => result.status === 'fulfilled' && result.value)
        .map((result) => result.value);

      await this._recalculateBroadcastStats(broadcast);

      if (updatedCalls.length > 0) {
        emitBatchUpdate(broadcastId, updatedCalls);
      }

      emitBroadcastUpdate(broadcastId, {
        status: broadcast.status,
        stats: broadcast.stats,
        activeCalls: activeCalls + callsToMake.length
      });

      return dispatchIntervalMs;
    } catch (error) {
      logger.error(`Error processing broadcast queue ${broadcastId}:`, error);
      return this.DEFAULT_DISPATCH_INTERVAL_MS;
    }
  }

  async _claimNextCalls(broadcast, broadcastId, limit, maxRetries = 2) {
    const calls = [];
    const maxAttempts = Math.max(1, Number(maxRetries) || 2);

    for (let index = 0; index < limit; index += 1) {
      const now = new Date();
      const call = await BroadcastCall.findOneAndUpdate(
        {
          broadcast: broadcastId,
          userId: broadcast.createdBy,
          status: 'queued',
          attempts: { $lt: maxAttempts },
          $or: [
            { retryAfter: { $exists: false } },
            { retryAfter: null },
            { retryAfter: { $lte: now } }
          ]
        },
        {
          $set: {
            status: 'claiming',
            claimedAt: now
          }
        },
        {
          sort: { attempts: 1, createdAt: 1 },
          new: true
        }
      ).lean();

      if (!call) break;
      calls.push(call);
    }

    return calls;
  }

  async _initiateCall(callDoc, broadcast) {
    try {
      const call = await BroadcastCall.findOne({ _id: callDoc._id, userId: broadcast.createdBy });
      if (!call) {
        logger.error(`Call ${callDoc._id} not found`);
        return null;
      }

      emitCallUpdate(broadcast._id.toString(), {
        ...this._formatCallPayload(call),
        status: 'claiming'
      });

      if (broadcast.config?.compliance?.dndRespect) {
        const dndStatus = await this._checkDND(call.contact.phone);
        if (dndStatus === 'blocked') {
          call.dndStatus = 'blocked';
          call.status = 'failed';
          call.claimedAt = undefined;
          call.endTime = new Date();
          await call.save();

          const payload = this._formatCallPayload(call);
          emitCallUpdate(broadcast._id.toString(), payload);
          return payload;
        }
      }

      if (await this._isOptedOut(call.contact.phone)) {
        await call.markOptedOut();
        const payload = this._formatCallPayload(call);
        emitCallUpdate(broadcast._id.toString(), payload);
        return payload;
      }

      const credentials = await adminCredentialsService.getTwilioCredentialsByUserId(String(broadcast.createdBy));
      if (!credentials?.twilioAccountSid || !credentials?.twilioAuthToken || !credentials?.twilioPhoneNumber) {
        throw new Error('Twilio credentials missing for broadcast owner');
      }

      const baseUrl = String(process.env.BASE_URL || '').replace(/\/$/, '');
      if (!baseUrl) {
        throw new Error('Missing BASE_URL for Twilio webhook callbacks');
      }

      const twilioResponse = await twilioVoiceService.makeVoiceBroadcastCall(
        {
          to: call.contact.phone,
          audioUrl: call.personalizedMessage.audioUrl,
          messageText: call.personalizedMessage.text,
          voice: broadcast.voice.voiceId,
          language: broadcast.voice.language,
          disclaimerText: broadcast.config.compliance.disclaimerText,
          callbackUrl: `${baseUrl}/webhook/broadcast/${call._id}/status`
        },
        {
          twilioAccountSid: credentials.twilioAccountSid,
          twilioAuthToken: credentials.twilioAuthToken,
          twilioPhoneNumber: credentials.twilioPhoneNumber
        }
      );

      await call.markCalling(twilioResponse.sid);
      logger.info(`Call initiated: ${call._id} -> ${call.contact.phone} (${twilioResponse.sid})`);

      const payload = this._formatCallPayload(call);
      emitCallUpdate(broadcast._id.toString(), payload);
      return payload;
    } catch (error) {
      logger.error(`Failed to initiate call ${callDoc._id}:`, error);

      const call = await BroadcastCall.findById(callDoc._id);
      if (!call) return null;

      await call.markFailed(error.code || 500, error.message, true, {
        maxAttempts: Math.max(1, Number(broadcast.config?.maxRetries) || 2),
        retryDelayMs: Math.max(0, Number(broadcast.config?.retryDelay) || 300000)
      });
      call.claimedAt = undefined;
      await call.save();

      const payload = this._formatCallPayload(call);
      emitCallUpdate(call.broadcast.toString(), payload);
      return payload;
    }
  }

  _formatCallPayload(call) {
    return {
      callId: call._id,
      _id: call._id,
      userId: call.userId || null,
      callSid: call.callSid || null,
      phone: call.contact?.phone || '',
      contact: call.contact || {},
      status: call.status,
      attempts: call.attempts || 0,
      duration: call.duration || 0,
      startTime: call.startTime || null,
      answerTime: call.answerTime || null,
      endTime: call.endTime || null,
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
      error: call.twilioError || null
    };
  }

  _clampNumber(value, fallback, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(numeric)));
  }

  async _recoverStaleClaims(broadcast) {
    const staleBefore = new Date(Date.now() - this.CLAIM_TIMEOUT_MS);
    const maxAttempts = Math.max(1, Number(broadcast.config?.maxRetries) || 2);

    await BroadcastCall.updateMany(
      {
        broadcast: broadcast._id,
        userId: broadcast.createdBy,
        status: 'claiming',
        claimedAt: { $lte: staleBefore },
        attempts: { $lt: maxAttempts }
      },
      {
        $set: { status: 'queued' },
        $unset: { claimedAt: '' }
      }
    );

    await BroadcastCall.updateMany(
      {
        broadcast: broadcast._id,
        userId: broadcast.createdBy,
        status: 'claiming',
        claimedAt: { $lte: staleBefore },
        attempts: { $gte: maxAttempts }
      },
      {
        $set: {
          status: 'failed',
          endTime: new Date(),
          twilioError: {
            code: 408,
            message: 'Call claim expired before provider dispatch'
          }
        },
        $unset: { claimedAt: '' }
      }
    );
  }

  async _recalculateBroadcastStats(broadcast) {
    const stats = await BroadcastCall.aggregate([
      { $match: { broadcast: broadcast._id, userId: broadcast.createdBy } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const statMap = {};
    stats.forEach((stat) => {
      statMap[stat._id] = stat.count;
    });

    broadcast.stats = {
      total: broadcast.stats.total,
      queued: (statMap.queued || 0) + (statMap.claiming || 0),
      calling: (statMap.calling || 0) + (statMap.ringing || 0) + (statMap.in_progress || 0) + (statMap.answered || 0),
      answered: statMap.answered || 0,
      completed: statMap.completed || 0,
      failed: (statMap.failed || 0) + (statMap.busy || 0) + (statMap.no_answer || 0),
      opted_out: statMap.opted_out || 0
    };

    await broadcast.save();
  }

  async _shouldTriggerAIFallback(call, broadcast, error) {
    try {
      const healthCheck = await aiAssistantService.constructor.checkHealth?.();
      if (healthCheck?.status !== 'ok') return false;
      if (!broadcast.config.enableAIFallback) return false;

      const aiFallbackReasons = ['no-answer', 'busy', 'failed', 'timeout'];
      const failureReason = error.code || error.message || '';
      const shouldFallback = aiFallbackReasons.some((reason) =>
        failureReason.toLowerCase().includes(reason)
      );

      if (call.attempts < 1) return false;
      if (call.providerData?.aiFallback?.triggered) return false;
      return shouldFallback;
    } catch (fallbackError) {
      logger.error('Error checking AI fallback conditions:', fallbackError);
      return false;
    }
  }

  async _isOptedOut() {
    return false;
  }

  async _checkDND() {
    return 'allowed';
  }

  getActiveBroadcastsCount() {
    return this.activeBroadcasts.size;
  }
}

export default new BroadcastQueueService();
