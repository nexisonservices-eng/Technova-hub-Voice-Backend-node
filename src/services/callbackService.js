import logger from '../utils/logger.js';
import Call from '../models/call.js';
import twilioVoiceService from './twilioVoiceService.js';
import callStateService from './callStateService.js';
import { emitCallbackUpdate } from '../sockets/unifiedSocket.js';

class CallbackService {
  constructor() {
    this.activeCallbacks = new Map(); // callbackId -> timeout
    this.CHECK_INTERVAL = 60000; // 1 minute
    this.MAX_CONCURRENT_CALLBACKS = 5;
    this.currentCallbacks = 0;
    
    this.startCallbackProcessor();
    logger.info('✓ Callback Service Initialized');
  }

  /**
   * Start the callback processor
   */
  startCallbackProcessor() {
    setInterval(async () => {
      await this.processPendingCallbacks();
    }, this.CHECK_INTERVAL);
  }

  /**
   * Schedule a new callback
   */
  async scheduleCallback(callbackData) {
    try {
      const {
        originalCallSid,
        phoneNumber,
        requestedBy,
        priority = 'normal',
        scheduledFor = new Date(Date.now() + 15 * 60 * 1000), // 15 minutes default
        context = {},
        notes
      } = callbackData;

      // Validate phone number
      if (!phoneNumber || !phoneNumber.match(/^\+?[1-9]\d{1,14}$/)) {
        throw new Error('Invalid phone number format');
      }

      // Create callback record using existing Call model
      const callback = await Call.create({
        callSid: `CB_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        phoneNumber,
        direction: 'outbound',
        status: 'scheduled',
        provider: 'twilio',
        tags: ['callback', priority],
        notes: notes || `Callback requested during ${context.originalCallContext || 'inbound'} call`,
        providerData: {
          originalCallSid,
          requestedBy,
          priority,
          scheduledFor,
          context,
          callbackType: 'scheduled',
          maxAttempts: 3,
          retryDelay: 15 * 60 * 1000, // 15 minutes
          attempts: 0
        },
        startTime: scheduledFor
      });

      logger.info(`📞 Callback scheduled: ${callback.callSid} -> ${phoneNumber} at ${scheduledFor}`);

      // Emit real-time update
      emitCallbackUpdate({
        action: 'scheduled',
        callback: {
          id: callback._id,
          callSid: callback.callSid,
          phoneNumber: callback.phoneNumber,
          priority: priority,
          scheduledFor: callback.scheduledFor
        }
      });

      return callback;
    } catch (error) {
      logger.error('Failed to schedule callback:', error);
      throw error;
    }
  }

  /**
   * Process pending callbacks
   */
  async processPendingCallbacks() {
    try {
      if (this.currentCallbacks >= this.MAX_CONCURRENT_CALLBACKS) {
        logger.debug('Max concurrent callbacks reached');
        return;
      }

      const pendingCallbacks = await Call.find({
        tags: { $in: ['callback'] },
        status: 'scheduled',
        startTime: { $lte: new Date() }
      })
      .sort({ tags: -1, startTime: 1 }) // Priority first, then time
      .limit(this.MAX_CONCURRENT_CALLBACKS - this.currentCallbacks);

      if (pendingCallbacks.length === 0) {
        return;
      }

      logger.info(`📞 Processing ${pendingCallbacks.length} pending callbacks`);

      await Promise.allSettled(
        pendingCallbacks.map(callback => this.attemptCallback(callback))
      );

    } catch (error) {
      logger.error('Error processing pending callbacks:', error);
    }
  }

  /**
   * Attempt to make a callback
   */
  async attemptCallback(callback) {
    try {
      this.currentCallbacks++;

      logger.info(`📞 Attempting callback: ${callback.callSid} -> ${callback.phoneNumber}`);

      // Mark as attempted
      callback.status = 'attempted';
      callback.providerData.attempts += 1;
      callback.providerData.lastAttemptAt = new Date();
      await callback.save();

      // Create outbound call
      const callResult = await twilioVoiceService.makeVoiceBroadcastCall({
        to: callback.phoneNumber,
        audioUrl: `${process.env.BASE_URL}/audio/callback-greeting.mp3`,
        disclaimerText: 'This is a scheduled callback from our system',
        callbackUrl: `${process.env.BASE_URL}/webhook/callback/status/${callback._id}`
      });

      // Update callback with Twilio call SID
      callback.providerData.twilioCallSid = callResult.sid;
      callback.providerData.attemptedAt = new Date();
      await callback.save();

      // Emit real-time update
      emitCallbackUpdate({
        action: 'attempted',
        callback: {
          id: callback._id,
          callSid: callback.callSid,
          phoneNumber: callback.phoneNumber,
          twilioCallSid: callResult.sid,
          attempt: callback.providerData.attempts
        }
      });

      logger.info(`📞 Callback initiated: ${callback.callSid} -> ${callResult.sid}`);

    } catch (error) {
      logger.error(`Failed to attempt callback ${callback.callSid}:`, error);

      // Mark as failed
      callback.status = 'failed';
      callback.error = {
        code: 'CALL_FAILED',
        message: error.message
      };
      await callback.save();

      // Emit failure update
      emitCallbackUpdate({
        action: 'failed',
        callback: {
          id: callback._id,
          callSid: callback.callSid,
          phoneNumber: callback.phoneNumber,
          error: error.message
        }
      });

    } finally {
      this.currentCallbacks--;
    }
  }

  /**
   * Handle callback status updates from Twilio
   */
  async handleCallbackStatus(callbackId, statusData) {
    try {
      const callback = await Call.findById(callbackId);
      if (!callback) {
        logger.warn(`Callback not found: ${callbackId}`);
        return;
      }

      const { CallStatus, CallDuration, ErrorCode, ErrorMessage } = statusData;

      logger.info(`📞 Callback status: ${callback.callSid} -> ${CallStatus}`);

      // Update provider data
      callback.providerData = {
        ...callback.providerData,
        twilioStatus: CallStatus,
        twilioDuration: CallDuration,
        twilioErrorCode: ErrorCode,
        twilioErrorMessage: ErrorMessage,
        updatedAt: new Date()
      };

      // Handle different statuses
      if (CallStatus === 'completed') {
        callback.status = 'completed';
        callback.endTime = new Date();
        callback.duration = parseInt(CallDuration) || 0;
        
        emitCallbackUpdate({
          action: 'completed',
          callback: {
            id: callback._id,
            callSid: callback.callSid,
            phoneNumber: callback.phoneNumber,
            duration: parseInt(CallDuration) || 0
          }
        });

      } else if (['busy', 'no-answer', 'failed'].includes(CallStatus)) {
        callback.status = 'attempted';
        
        // Check if we should retry
        if (callback.providerData.attempts < callback.providerData.maxAttempts) {
          callback.providerData.nextAttemptAt = new Date(Date.now() + callback.providerData.retryDelay);
          callback.startTime = callback.providerData.nextAttemptAt;
          callback.status = 'scheduled';
          
          emitCallbackUpdate({
            action: 'retry_scheduled',
            callback: {
              id: callback._id,
              callSid: callback.callSid,
              phoneNumber: callback.phoneNumber,
              nextAttempt: callback.providerData.nextAttemptAt,
              attempt: callback.providerData.attempts
            }
          });
        } else {
          callback.status = 'failed';
          callback.error = {
            code: ErrorCode || 'MAX_ATTEMPTS',
            message: ErrorMessage || 'Maximum callback attempts reached'
          };
        }
      }

      await callback.save();

    } catch (error) {
      logger.error(`Error handling callback status for ${callbackId}:`, error);
    }
  }

  /**
   * Cancel a scheduled callback
   */
  async cancelCallback(callbackId, reason) {
    try {
      const callback = await Call.findById(callbackId);
      if (!callback) {
        throw new Error('Callback not found');
      }

      if (callback.status === 'completed') {
        throw new Error('Cannot cancel completed callback');
      }

      // Cancel Twilio call if in progress
      if (callback.providerData?.twilioCallSid) {
        try {
          await twilioVoiceService.endCall(callback.providerData.twilioCallSid);
        } catch (err) {
          logger.warn(`Failed to cancel Twilio call: ${err.message}`);
        }
      }

      callback.status = 'cancelled';
      callback.notes = reason || 'Cancelled by user';
      await callback.save();

      // Emit cancellation update
      emitCallbackUpdate({
        action: 'cancelled',
        callback: {
          id: callback._id,
          callSid: callback.callSid,
          phoneNumber: callback.phoneNumber,
          reason
        }
      });

      logger.info(`📞 Callback cancelled: ${callback.callSid}`);

      return callback;
    } catch (error) {
      logger.error('Failed to cancel callback:', error);
      throw error;
    }
  }

  /**
   * Reschedule a callback
   */
  async rescheduleCallback(callbackId, newDate, reason) {
    try {
      const callback = await Call.findById(callbackId);
      if (!callback) {
        throw new Error('Callback not found');
      }

      if (callback.status === 'completed') {
        throw new Error('Cannot reschedule completed callback');
      }

      callback.startTime = newDate;
      callback.status = 'scheduled';
      callback.providerData.nextAttemptAt = newDate;
      callback.providerData.attempts = 0;
      callback.notes = reason || 'Rescheduled';

      // Emit reschedule update
      emitCallbackUpdate({
        action: 'rescheduled',
        callback: {
          id: callback._id,
          callSid: callback.callSid,
          phoneNumber: callback.phoneNumber,
          newScheduledFor: newDate,
          reason
        }
      });

      logger.info(`📞 Callback rescheduled: ${callback.callSid} to ${newDate}`);

      return callback;
    } catch (error) {
      logger.error('Failed to reschedule callback:', error);
      throw error;
    }
  }

  /**
   * Get callback statistics
   */
  async getCallbackStats(period = 'today') {
    try {
      const now = new Date();
      let startDate;

      switch (period) {
        case 'today':
          startDate = new Date(now);
          startDate.setHours(0, 0, 0, 0);
          break;
        case 'week':
          startDate = new Date(now);
          startDate.setDate(now.getDate() - 7);
          break;
        case 'month':
          startDate = new Date(now);
          startDate.setMonth(now.getMonth() - 1);
          break;
        default:
          startDate = new Date(now);
          startDate.setHours(0, 0, 0, 0);
      }

      const stats = await Call.aggregate([
        { 
          $match: { 
            tags: { $in: ['callback'] },
            createdAt: { $gte: startDate }
          } 
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            avgAttempts: { $avg: '$providerData.attempts' }
          }
        }
      ]);

      const statMap = {};
      stats.forEach(stat => {
        statMap[stat._id] = {
          count: stat.count,
          avgAttempts: Math.round(stat.avgAttempts * 10) / 10
        };
      });

      const pendingCount = await Call.countDocuments({
        tags: { $in: ['callback'] },
        status: 'scheduled',
        startTime: { $lte: new Date() }
      });

      return {
        period,
        dateRange: { start: startDate, end: now },
        stats: statMap,
        pendingCount,
        currentCallbacks: this.currentCallbacks,
        maxConcurrent: this.MAX_CONCURRENT_CALLBACKS
      };

    } catch (error) {
      logger.error('Failed to get callback stats:', error);
      throw error;
    }
  }

  /**
   * Get callbacks by phone number
   */
  async getCallbacksByPhone(phoneNumber) {
    try {
      return await Call.find({
        phoneNumber,
        tags: { $in: ['callback'] }
      })
      .sort({ createdAt: -1 })
      .limit(10);
    } catch (error) {
      logger.error('Failed to get callbacks by phone:', error);
      throw error;
    }
  }

  /**
   * Get active callbacks
   */
  async getActiveCallbacks() {
    try {
      return await Call.find({
        tags: { $in: ['callback'] },
        status: { $in: ['scheduled', 'attempted'] }
      });
    } catch (error) {
      logger.error('Failed to get active callbacks:', error);
      throw error;
    }
  }

  /**
   * Clean up old callbacks
   */
  async cleanupOldCallbacks(daysOld = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const result = await Call.deleteMany({
        tags: { $in: ['callback'] },
        status: { $in: ['completed', 'failed', 'cancelled'] },
        updatedAt: { $lt: cutoffDate }
      });

      logger.info(`🧹 Cleaned up ${result.deletedCount} old callbacks`);
      return result.deletedCount;

    } catch (error) {
      logger.error('Failed to cleanup old callbacks:', error);
      throw error;
    }
  }
}

export default new CallbackService();
