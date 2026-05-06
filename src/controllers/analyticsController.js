import Call from '../models/call.js';
import BroadcastCall from '../models/BroadcastCall.js';
import ExecutionLog from '../models/ExecutionLog.js';
import Workflow from '../models/Workflow.js';
import User from '../models/user.js';
import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import { getIO } from '../sockets/unifiedSocket.js';
import { getRawUserId, getUserObjectId } from '../utils/authContext.js';
import { getDateRangeInTimezone } from '../utils/timezoneDate.js';

const VOICE_TIME_ZONE = 'Asia/Kolkata';

/**
 * Production-level Analytics Controller
 * Handles comprehensive call analytics with caching and real-time updates
 */
class AnalyticsController {
  constructor() {
    this.cache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.ANALYTICS_ROOM = 'analytics_room';
    this.ANALYTICS_ROOM_PREFIX = 'analytics_room:';
    this.broadcastDebounceMs = 500;
    this.broadcastTimer = null;
    this.pendingBroadcastKeys = new Map();
    this.activeAnalyticsSubscriptions = new Map();
    this.inFlightAnalytics = new Map();
    this.cacheVersion = 0;
  }

  /**
   * Get comprehensive inbound analytics
   */
  async getInboundAnalytics(req, res) {
    try {
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const { period = 'today', callType = 'all', status = 'all' } = req.query;
      const analyticsData = await this.getOrGenerateInboundAnalytics({ period, callType, status, userId: String(userId) });

      res.json({
        success: true,
        data: analyticsData,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('[Analytics] Failed to get inbound analytics:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate analytics',
        message: error.message
      });
    }
  }

  /**
   * Get unified voice dashboard stats for today
   * Includes inbound/ivr/outbound (Call model) + broadcast outbound (BroadcastCall model)
   */
  async getVoiceTodayStats(req, res) {
    try {
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const dateRange = this.getDateRange('today');
      const callFilter = {
        user: userId,
        createdAt: { $gte: dateRange.start, $lte: dateRange.end }
      };
      const broadcastFilter = {
        userId,
        $or: [
          { createdAt: { $gte: dateRange.start, $lte: dateRange.end } },
          { startTime: { $gte: dateRange.start, $lte: dateRange.end } },
          { answerTime: { $gte: dateRange.start, $lte: dateRange.end } },
          { endTime: { $gte: dateRange.start, $lte: dateRange.end } }
        ]
      };

      const callActiveStatuses = ['initiated', 'ringing', 'in-progress'];
      const broadcastActiveStatuses = ['calling', 'ringing', 'in_progress', 'answered'];

      const [callStatsAgg, broadcastStatsAgg, activeCallCount, activeBroadcastCount] = await Promise.all([
        this.getSummaryStats(dateRange, 'all', 'all', { user: userId }),
        BroadcastCall.aggregate([
          { $match: broadcastFilter },
          {
            $group: {
              _id: null,
              totalCalls: { $sum: 1 },
              completedCalls: {
                $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
              },
              failedCalls: {
                $sum: { $cond: [{ $in: ['$status', ['failed', 'busy', 'no_answer', 'cancelled']] }, 1, 0] }
              },
              answeredCalls: {
                $sum: { $cond: [{ $eq: ['$status', 'answered'] }, 1, 0] }
              },
              avgDuration: { $avg: '$duration' },
              totalDuration: { $sum: '$duration' }
            }
          }
        ]),
        Call.countDocuments({ ...callFilter, status: { $in: callActiveStatuses } }),
        BroadcastCall.countDocuments({ ...broadcastFilter, status: { $in: broadcastActiveStatuses } })
      ]);

      const callStats = callStatsAgg || {};
      const broadcastStats = broadcastStatsAgg[0] || {
        totalCalls: 0,
        completedCalls: 0,
        failedCalls: 0,
        answeredCalls: 0,
        avgDuration: 0,
        totalDuration: 0
      };

      const totalCalls = (callStats.totalCalls || 0) + (broadcastStats.totalCalls || 0);
      const completedCalls = (callStats.completedCalls || 0) + (broadcastStats.completedCalls || 0);
      const failedCalls = (callStats.failedCalls || 0) + (broadcastStats.failedCalls || 0);
      const totalDuration = (callStats.totalDuration || 0) + (broadcastStats.totalDuration || 0);

      const avgDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;
      const successRate = totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0;

      return res.json({
        success: true,
        data: {
          summary: {
            totalCalls,
            avgDuration,
            successRate,
            completedCalls,
            failedCalls,
            inboundCalls: callStats.inboundCalls || 0,
            ivrCalls: callStats.ivrCalls || 0,
            inboundIvrCalls: (callStats.inboundCalls || 0) + (callStats.ivrCalls || 0),
            outboundCalls: (callStats.outboundCalls || 0) + (broadcastStats.totalCalls || 0),
            broadcastCalls: broadcastStats.totalCalls || 0,
            activeCalls: activeCallCount + activeBroadcastCount
          },
          breakdown: {
            callModel: {
              totalCalls: callStats.totalCalls || 0,
              completedCalls: callStats.completedCalls || 0,
              failedCalls: callStats.failedCalls || 0,
              totalDuration: callStats.totalDuration || 0
            },
            broadcastModel: {
              totalCalls: broadcastStats.totalCalls || 0,
              completedCalls: broadcastStats.completedCalls || 0,
              failedCalls: broadcastStats.failedCalls || 0,
              answeredCalls: broadcastStats.answeredCalls || 0,
              totalDuration: broadcastStats.totalDuration || 0
            }
          },
          generatedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('[Analytics] Failed to get voice today stats:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate voice dashboard stats',
        message: error.message
      });
    }
  }

  buildCacheKey(period = 'today', callType = 'all', status = 'all', userId = 'anonymous') {
    return `analytics_${userId}_${period}_${callType}_${status}`;
  }

  getRecentCallLimit() {
    const configuredLimit = Number(process.env.ANALYTICS_RECENT_CALL_LIMIT || 200);
    return Math.max(1, Math.min(Number.isFinite(configuredLimit) ? configuredLimit : 200, 500));
  }

  normalizeAnalyticsPayload(payload = {}, fallbackUserId = null) {
    return {
      period: payload.period || 'today',
      callType: payload.callType || 'all',
      status: payload.status || 'all',
      userId: payload.userId ? String(payload.userId) : (fallbackUserId ? String(fallbackUserId) : null)
    };
  }

  buildSubscriptionKey({ period = 'today', callType = 'all', status = 'all', userId = null } = {}) {
    return [userId ? String(userId) : 'global', period || 'today', callType || 'all', status || 'all'].join('|');
  }

  registerAnalyticsSubscription(socket, payload = {}) {
    if (!socket?.id) return null;
    const socketUserId = payload.userId || getRawUserId(socket.user);
    const subscription = this.normalizeAnalyticsPayload(payload, socketUserId);
    this.activeAnalyticsSubscriptions.set(socket.id, subscription);
    return subscription;
  }

  unregisterAnalyticsSubscription(socketOrId) {
    const socketId = typeof socketOrId === 'string' ? socketOrId : socketOrId?.id;
    if (socketId) this.activeAnalyticsSubscriptions.delete(socketId);
  }

  getActiveBroadcastTargets(payload = {}) {
    const requestedUserId = payload.userId ? String(payload.userId) : null;
    const hasExplicitView = Boolean(payload.period || payload.callType || payload.status);

    if (hasExplicitView) {
      return [this.normalizeAnalyticsPayload(payload, requestedUserId)];
    }

    const targets = new Map();
    for (const subscription of this.activeAnalyticsSubscriptions.values()) {
      const subscriptionUserId = subscription.userId ? String(subscription.userId) : null;
      if (requestedUserId && subscriptionUserId !== requestedUserId) continue;
      targets.set(this.buildSubscriptionKey(subscription), subscription);
    }

    if (targets.size === 0) {
      const fallback = this.normalizeAnalyticsPayload({ ...payload, period: 'today', callType: 'all', status: 'all' }, requestedUserId);
      targets.set(this.buildSubscriptionKey(fallback), fallback);
    }

    return [...targets.values()];
  }

  getAnalyticsRoom(userId = null) {
    const resolvedUserId = userId ? String(userId) : '';
    return resolvedUserId ? `${this.ANALYTICS_ROOM_PREFIX}${resolvedUserId}` : this.ANALYTICS_ROOM;
  }

  async getOrGenerateInboundAnalytics({ period = 'today', callType = 'all', status = 'all', userId = null } = {}) {
    const normalizedPeriod = period || 'today';
    const normalizedCallType = callType || 'all';
    const normalizedStatus = status || 'all';
    const cacheKey = this.buildCacheKey(normalizedPeriod, normalizedCallType, normalizedStatus, userId || 'anonymous');

    if (userId) {
      const deletedCount = await this.enforceInboundRecentCallsRetention(userId, 100);
      if (deletedCount > 0) {
        this.clearUserCache(userId);
      }
    }

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    const inFlight = this.inFlightAnalytics.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const generationVersion = this.cacheVersion;
    const generation = this.generateInboundAnalytics({
      period: normalizedPeriod,
      callType: normalizedCallType,
      status: normalizedStatus,
      userId
    }).then((analyticsData) => {
      if (generationVersion === this.cacheVersion) {
        this.cache.set(cacheKey, {
          data: analyticsData,
          timestamp: Date.now()
        });
      }
      return analyticsData;
    }).finally(() => {
      this.inFlightAnalytics.delete(cacheKey);
    });

    this.inFlightAnalytics.set(cacheKey, generation);
    return generation;
  }

  async generateInboundAnalytics({ period = 'today', callType = 'all', status = 'all', userId = null } = {}) {
    const dateRange = this.getDateRange(period);
    const userObjectId = this.toObjectId(userId);
    const ownerFilter = {
      ...(userObjectId ? { user: userObjectId } : {}),
      deletedAt: null
    };

    const [
      summary,
      hourlyDistribution,
      ivrBreakdown,
      aiMetrics,
      users,
      ivr,
      queue,
      recentCalls,
      dailyBreakdown,
      channels,
      statusBreakdown
    ] = await Promise.all([
      this.getUnifiedSummaryStats(dateRange, callType, status, ownerFilter, userId),
      this.getUnifiedHourlyDistribution(dateRange, callType, status, ownerFilter, userId),
      this.getIVRBreakdown(dateRange, userId),
      this.getAIMetrics(dateRange, ownerFilter),
      this.getUsersStats(),
      this.getIVRStats(dateRange, userId),
      this.getQueueStats(dateRange, ownerFilter),
      this.getUnifiedRecentCalls(this.getRecentCallLimit(), dateRange, callType, status, ownerFilter, userId),
      this.getUnifiedDailyBreakdown(period, callType, status, ownerFilter, userId),
      this.getChannelStats(dateRange, callType, status, ownerFilter, userId),
      this.getUnifiedStatusBreakdown(dateRange, callType, status, ownerFilter, userId)
    ]);

    return {
      summary,
      channels,
      statusBreakdown,
      hourlyDistribution,
      ivrBreakdown,
      aiMetrics,
      users,
      ivr,
      queue,
      recentCalls,
      dailyBreakdown,
      period,
      filters: {
        callType,
        status
      },
      generatedAt: new Date().toISOString()
    };
  }

  async getChannelStats(dateRange, callType = 'all', status = 'all', ownerFilter = {}, userId = null) {
    const channels = this.getEmptyChannels();

    if (this.shouldIncludeCallModel(callType)) {
      const callPipeline = [
        { $match: this.buildCallMatch(dateRange, status, ownerFilter) },
        this.getComputedCallTypeStage()
      ];
      this.applyCallTypeFilter(callPipeline, callType);
      callPipeline.push({
        $group: {
          _id: '$computedCallType',
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $in: ['$status', ['initiated', 'ringing', 'answered', 'in-progress']] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'busy', 'no-answer', 'cancelled', 'canceled']] }, 1, 0] } },
          missed: { $sum: { $cond: [{ $in: ['$status', ['busy', 'no-answer', 'missed', 'abandoned']] }, 1, 0] } },
          totalDuration: { $sum: '$duration' }
        }
      });

      const callRows = await Call.aggregate(callPipeline);
      callRows.forEach((row) => {
        if (channels[row._id]) {
          this.mergeMetricBucket(channels[row._id], row);
        }
      });
    }

    if (this.shouldIncludeBroadcastModel(callType)) {
      const broadcastRows = await BroadcastCall.aggregate([
        { $match: this.buildBroadcastMatch(dateRange, status, userId) },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $in: ['$status', ['queued', 'claiming', 'calling', 'ringing', 'in_progress', 'answered']] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'busy', 'no_answer', 'cancelled', 'opted_out']] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $in: ['$status', ['busy', 'no_answer', 'missed', 'abandoned']] }, 1, 0] } },
            totalDuration: { $sum: '$duration' }
          }
        }
      ]);

      if (broadcastRows[0]) {
        this.mergeMetricBucket(channels.voiceBroadcast, broadcastRows[0]);
      }
    }

    channels.inboundIvr = this.getEmptyChannelMetrics();
    this.mergeMetricBucket(channels.inboundIvr, channels.inbound);
    this.mergeMetricBucket(channels.inboundIvr, channels.ivr);

    return channels;
  }

  async getUnifiedSummaryStats(dateRange, callType = 'all', status = 'all', ownerFilter = {}, userId = null) {
    const channels = await this.getChannelStats(dateRange, callType, status, ownerFilter, userId);
    const summary = {
      totalCalls: 0,
      activeCalls: 0,
      completedCalls: 0,
      failedCalls: 0,
      missedCalls: 0,
      voicemails: 0,
      callbacks: 0,
      avgDuration: 0,
      totalDuration: 0,
      successRate: 0,
      inboundCalls: channels.inbound.total,
      ivrCalls: channels.ivr.total,
      inboundIvrCalls: channels.inboundIvr.total,
      outboundCalls: channels.outbound.total,
      broadcastCalls: channels.voiceBroadcast.total,
      quickCalls: 0,
      outboundCompletedCalls: channels.outbound.completed,
      outboundFailedCalls: channels.outbound.failed
    };

    [channels.voiceBroadcast, channels.inbound, channels.ivr, channels.outbound].forEach((bucket) => {
      summary.totalCalls += bucket.total;
      summary.activeCalls += bucket.active;
      summary.completedCalls += bucket.completed;
      summary.failedCalls += bucket.failed;
      summary.missedCalls += bucket.missed;
      summary.totalDuration += bucket.totalDuration;
    });

    if (this.shouldIncludeCallModel(callType)) {
      const extraPipeline = [
        { $match: this.buildCallMatch(dateRange, status, ownerFilter) },
        this.getComputedCallTypeStage()
      ];
      this.applyCallTypeFilter(extraPipeline, callType);
      extraPipeline.push({
        $group: {
          _id: null,
          voicemails: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$voicemail', null] }, null] }, 1, 0] } },
          callbacks: {
            $sum: {
              $cond: [
                { $or: [{ $eq: ['$callbackRequested', true] }, { $eq: ['$callback.requested', true] }] },
                1,
                0
              ]
            }
          },
          quickCalls: { $sum: { $cond: [{ $eq: ['$direction', 'outbound-local'] }, 1, 0] } }
        }
      });
      const extra = await Call.aggregate(extraPipeline);
      summary.voicemails = Number(extra[0]?.voicemails || 0);
      summary.callbacks = Number(extra[0]?.callbacks || 0);
      summary.quickCalls = Number(extra[0]?.quickCalls || 0);
    }

    summary.avgDuration = summary.totalCalls > 0 ? Math.round(summary.totalDuration / summary.totalCalls) : 0;
    summary.successRate = summary.totalCalls > 0 ? Math.round((summary.completedCalls / summary.totalCalls) * 100) : 0;
    summary.answerRate = summary.successRate;
    return summary;
  }

  async getUnifiedHourlyDistribution(dateRange, callType = 'all', status = 'all', ownerFilter = {}, userId = null) {
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      calls: 0,
      total: 0,
      completed: 0,
      failed: 0,
      inbound: 0,
      ivr: 0,
      inboundIvr: 0,
      outbound: 0,
      voiceBroadcast: 0,
      successRate: 0
    }));

    if (this.shouldIncludeCallModel(callType)) {
      const callPipeline = [
        { $match: this.buildCallMatch(dateRange, status, ownerFilter) },
        this.getComputedCallTypeStage()
      ];
      this.applyCallTypeFilter(callPipeline, callType);
      callPipeline.push(
        {
          $group: {
            _id: { hour: { $hour: { date: '$createdAt', timezone: VOICE_TIME_ZONE } }, type: '$computedCallType' },
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'busy', 'no-answer', 'cancelled', 'canceled']] }, 1, 0] } }
          }
        },
        { $sort: { '_id.hour': 1 } }
      );

      const callRows = await Call.aggregate(callPipeline);
      callRows.forEach((row) => {
        const bucket = hours[row._id.hour];
        const type = row._id.type;
        if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, type)) return;
        bucket[type] += row.total;
        bucket.calls += row.total;
        bucket.total += row.total;
        bucket.completed += row.completed;
        bucket.failed += row.failed;
      });
    }

    if (this.shouldIncludeBroadcastModel(callType)) {
      const broadcastRows = await BroadcastCall.aggregate([
        { $match: this.buildBroadcastMatch(dateRange, status, userId) },
        {
          $group: {
            _id: { $hour: { date: '$createdAt', timezone: VOICE_TIME_ZONE } },
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'busy', 'no_answer', 'cancelled', 'opted_out']] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      broadcastRows.forEach((row) => {
        const bucket = hours[row._id];
        if (!bucket) return;
        bucket.voiceBroadcast += row.total;
        bucket.calls += row.total;
        bucket.total += row.total;
        bucket.completed += row.completed;
        bucket.failed += row.failed;
      });
    }

    return hours.map((bucket) => ({
      ...bucket,
      inboundIvr: bucket.inbound + bucket.ivr,
      successRate: bucket.total > 0 ? Math.round((bucket.completed / bucket.total) * 100) : 0
    }));
  }

  async getUnifiedStatusBreakdown(dateRange, callType = 'all', status = 'all', ownerFilter = {}, userId = null) {
    const breakdown = {};
    const addStatus = (key, count) => {
      const normalized = String(key || 'unknown').replace(/_/g, '-');
      breakdown[normalized] = (breakdown[normalized] || 0) + Number(count || 0);
    };

    if (this.shouldIncludeCallModel(callType)) {
      const callPipeline = [
        { $match: this.buildCallMatch(dateRange, status, ownerFilter) },
        this.getComputedCallTypeStage()
      ];
      this.applyCallTypeFilter(callPipeline, callType);
      callPipeline.push({ $group: { _id: '$status', count: { $sum: 1 } } });

      const callRows = await Call.aggregate(callPipeline);
      callRows.forEach((row) => addStatus(row._id, row.count));
    }

    if (this.shouldIncludeBroadcastModel(callType)) {
      const broadcastRows = await BroadcastCall.aggregate([
        { $match: this.buildBroadcastMatch(dateRange, status, userId) },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      broadcastRows.forEach((row) => addStatus(row._id, row.count));
    }

    return breakdown;
  }

  /**
   * Get summary statistics
   */
  async getSummaryStats(dateRange, callType, status, ownerFilter = {}) {
    const matchStage = {
      ...ownerFilter,
      createdAt: { $gte: dateRange.start, $lte: dateRange.end }
    };

    if (status && status !== 'all') {
      if (status === 'missed') {
        matchStage.status = { $in: ['busy', 'no-answer', 'missed', 'abandoned'] };
      } else {
        matchStage.status = status;
      }
    }

    const pipeline = [
      { $match: matchStage },
      {
        $addFields: {
          computedCallType: {
            $cond: [
              { $eq: ['$direction', 'outbound-local'] },
              'outbound_quickcalls',
              {
                $cond: [
                  { $eq: ['$direction', 'outbound'] },
                  'outbound',
                  {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$direction', 'inbound'] },
                          { $ne: [{ $ifNull: ['$routing', 'default'] }, 'default'] }
                        ]
                      },
                      'ivr',
                      'inbound'
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    ];

    if (callType && callType !== 'all') {
      if (callType === 'outbound') {
        pipeline.push({ $match: { computedCallType: { $in: ['outbound', 'outbound_quickcalls'] } } });
      } else {
        pipeline.push({ $match: { computedCallType: callType } });
      }
    }

    pipeline.push(
      {
        $group: {
          _id: null,
          totalCalls: { $sum: 1 },
          inboundCalls: {
            $sum: { $cond: [{ $eq: ['$computedCallType', 'inbound'] }, 1, 0] }
          },
          ivrCalls: {
            $sum: { $cond: [{ $eq: ['$computedCallType', 'ivr'] }, 1, 0] }
          },
          outboundCalls: {
            $sum: { $cond: [{ $in: ['$computedCallType', ['outbound', 'outbound_quickcalls']] }, 1, 0] }
          },
          outboundCompletedCalls: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ['$computedCallType', ['outbound', 'outbound_quickcalls']] },
                    { $eq: ['$status', 'completed'] }
                  ]
                },
                1,
                0
              ]
            }
          },
          outboundFailedCalls: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ['$computedCallType', ['outbound', 'outbound_quickcalls']] },
                    { $eq: ['$status', 'failed'] }
                  ]
                },
                1,
                0
              ]
            }
          },
          quickCalls: {
            $sum: { $cond: [{ $eq: ['$computedCallType', 'outbound_quickcalls'] }, 1, 0] }
          },
          completedCalls: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          failedCalls: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
          },
          missedCalls: {
            $sum: {
              $cond: [
                { $in: ['$status', ['busy', 'no-answer', 'missed', 'abandoned']] },
                1,
                0
              ]
            }
          },
          voicemails: {
            $sum: {
              $cond: [{ $ne: [{ $ifNull: ['$voicemail', null] }, null] }, 1, 0]
            }
          },
          callbacks: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$callbackRequested', true] },
                    { $eq: ['$callback.requested', true] }
                  ]
                },
                1,
                0
              ]
            }
          },
          avgDuration: { $avg: '$duration' },
          totalDuration: { $sum: '$duration' }
        }
      }
    );

    const stats = await Call.aggregate(pipeline);

    if (stats.length === 0) {
      return {
        totalCalls: 0,
        inboundCalls: 0,
        ivrCalls: 0,
        outboundCalls: 0,
        outboundCompletedCalls: 0,
        outboundFailedCalls: 0,
        quickCalls: 0,
        completedCalls: 0,
        failedCalls: 0,
        missedCalls: 0,
        voicemails: 0,
        callbacks: 0,
        avgDuration: 0,
        totalDuration: 0,
        successRate: 0
      };
    }

    const result = stats[0];
    result.avgDuration = Math.round(result.avgDuration || 0);
    result.successRate = result.totalCalls > 0 
      ? Math.round((result.completedCalls / result.totalCalls) * 100) 
      : 0;
    result.answerRate = result.successRate;

    return result;
  }

  /**
   * Get hourly distribution
   */
  async getHourlyDistribution(dateRange, ownerFilter = {}) {
    const data = await Call.aggregate([
      {
        $match: {
          ...ownerFilter,
          createdAt: { $gte: dateRange.start, $lte: dateRange.end }
        }
      },
      {
        $group: {
          _id: { $hour: { date: '$createdAt', timezone: VOICE_TIME_ZONE } },
          calls: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          failed: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
          },
          avgDuration: { $avg: '$duration' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Fill in missing hours
    const hours = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      calls: 0,
      completed: 0,
      failed: 0,
      avgDuration: 0
    }));

    data.forEach(h => {
      hours[h._id] = {
        hour: h._id,
        calls: h.calls,
        completed: h.completed,
        failed: h.failed,
        avgDuration: Math.round(h.avgDuration || 0)
      };
    });

    return hours;
  }

  /**
   * Get IVR breakdown
   */
  async getIVRBreakdown(dateRange, userId = null) {
    const executionFilter = {
      startTime: { $gte: dateRange.start, $lte: dateRange.end }
    };
    if (userId) executionFilter.userId = userId;
    const data = await ExecutionLog.aggregate([
      {
        $match: executionFilter
      },
      {
        $group: {
          _id: '$currentNodeType',
          count: { $sum: 1 }
        }
      }
    ]);

    const breakdown = {};
    data.forEach(item => {
      breakdown[item._id || 'unknown'] = item.count;
    });

    return breakdown;
  }

  /**
   * Get AI metrics
   */
  async getAIMetrics(dateRange, ownerFilter = {}) {
    const aiCalls = await Call.aggregate([
      {
        $match: {
          ...ownerFilter,
          createdAt: { $gte: dateRange.start, $lte: dateRange.end },
          aiAssisted: true
        }
      },
      {
        $group: {
          _id: null,
          aiCalls: { $sum: 1 },
          totalExchanges: { $sum: { $ifNull: ['$aiExchanges', 0] } },
          avgResponseTime: { $avg: '$aiResponseTime' },
          escalations: {
            $sum: { $cond: [{ $eq: ['$aiEscalated', true] }, 1, 0] }
          },
          intentMatches: {
            $sum: { $cond: [{ $eq: ['$intentMatched', true] }, 1, 0] }
          }
        }
      }
    ]);

    const totalCalls = await Call.countDocuments({
      ...ownerFilter,
      createdAt: { $gte: dateRange.start, $lte: dateRange.end }
    });

    if (aiCalls.length === 0) {
      return {
        aiCalls: 0,
        aiEngagementRate: 0,
        totalExchanges: 0,
        avgResponseTime: 0,
        escalations: 0,
        intentMatchRate: 0
      };
    }

    const result = aiCalls[0];
    result.aiEngagementRate = totalCalls > 0 
      ? Math.round((result.aiCalls / totalCalls) * 100) 
      : 0;
    result.intentMatchRate = result.aiCalls > 0 
      ? Math.round((result.intentMatches / result.aiCalls) * 100) 
      : 0;

    return result;
  }

  /**
   * Get users/agents stats
   */
  async getUsersStats() {
    const [totalAgents, activeAgents, avgHandleTime, utilization] = await Promise.all([
      User.countDocuments({ role: 'agent' }),
      User.countDocuments({ role: 'agent', status: 'online' }),
      this.getAvgHandleTime(),
      this.getAgentUtilization()
    ]);

    return {
      totalAgents,
      activeAgents,
      avgHandleTime,
      utilizationRate: utilization
    };
  }

  /**
   * Get IVR stats
   */
  async getIVRStats(dateRange, userId = null) {
    const [containment, abandon, avgDuration, transfer] = await Promise.all([
      this.getIVRContainmentRate(dateRange, userId),
      this.getIVRAbandonRate(dateRange, userId),
      this.getIVRAvgDuration(dateRange, userId),
      this.getIVRTransferRate(dateRange, userId)
    ]);

    // Get flow performance
    const flows = await ExecutionLog.aggregate([
      {
        $match: {
          startTime: { $gte: dateRange.start, $lte: dateRange.end },
          ...(userId ? { userId } : {})
        }
      },
      {
        $group: {
          _id: '$workflowName',
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    const totalIVR = flows.reduce((sum, f) => sum + f.count, 0);

    return {
      containmentRate: containment,
      abandonRate: abandon,
      avgIVRDuration: avgDuration,
      transferRate: transfer,
      flows: flows.map(f => ({
        name: f._id || 'Unknown',
        count: f.count,
        usagePercent: totalIVR > 0 ? Math.round((f.count / totalIVR) * 100) : 0
      }))
    };
  }

  /**
   * Get queue stats
   */
  async getQueueStats(dateRange, ownerFilter = {}) {
    const stats = await Call.aggregate([
      {
        $match: {
          ...ownerFilter,
          direction: 'inbound',
          createdAt: { $gte: dateRange.start, $lte: dateRange.end },
          $or: [
            { queued: true },
            { queueWaitTime: { $gt: 0 } },
            { queuePosition: { $gt: 0 } }
          ]
        }
      },
      {
        $group: {
          _id: null,
          avgWaitTime: { $avg: '$queueWaitTime' },
          maxWaitTime: { $max: '$queueWaitTime' },
          totalQueued: { $sum: 1 },
          abandoned: {
            $sum: { $cond: [{ $eq: ['$status', 'abandoned'] }, 1, 0] }
          },
          serviceLevel: {
            $sum: {
              $cond: [
                { $lte: [{ $ifNull: ['$queueWaitTime', 0] }, 60] },
                1,
                0
              ]
            }
          },
          callbacks: {
            $sum: { $cond: [{ $eq: ['$callbackRequested', true] }, 1, 0] }
          }
        }
      }
    ]);

    if (stats.length === 0) {
      return {
        avgWaitTime: 0,
        maxWaitTime: 0,
        serviceLevel: 0,
        abandonRate: 0,
        longestQueue: 0,
        scheduledCallbacks: 0
      };
    }

    const result = stats[0];
    result.serviceLevel = result.totalQueued > 0 
      ? Math.round((result.serviceLevel / result.totalQueued) * 100) 
      : 0;
    result.abandonRate = result.totalQueued > 0 
      ? Math.round((result.abandoned / result.totalQueued) * 100) 
      : 0;

    // Get current longest queue
    const currentQueue = await Call.countDocuments({
      ...ownerFilter,
      queued: true,
      createdAt: { $gte: new Date(Date.now() - 3600000) }
    });
    result.longestQueue = currentQueue;

    return result;
  }

  /**
   * Get recent calls
   */
  async getRecentCalls(limit = 50, ownerFilter = {}) {
    const rows = await Call.find({
      ...ownerFilter,
      direction: 'inbound'
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('callSid phoneNumber from to direction routing status duration createdAt aiAssisted')
      .lean();

    return rows.map((call) => ({
      ...call,
      callType: this.resolveCallType(call),
      type: this.resolveCallType(call),
      phoneNumber: call.phoneNumber || call.from || call.to || '-'
    }));
  }

  async getUnifiedRecentCalls(limit = 100, dateRange, callType = 'all', status = 'all', ownerFilter = {}, userId = null) {
    const rows = [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));

    if (this.shouldIncludeCallModel(callType)) {
      const callQuery = this.buildCallMatch(dateRange, status, ownerFilter);
      const calls = await Call.find(callQuery)
        .sort({ createdAt: -1 })
        .limit(safeLimit)
      .select('callSid phoneNumber from to direction routing status duration createdAt updatedAt provider providerData')
      .lean();

      const matchesRequestedType = (call) => (
        !callType ||
        callType === 'all' ||
        call.type === callType ||
        (callType === 'inboundIvr' && ['inbound', 'ivr'].includes(call.type))
      );

      rows.push(...calls
        .map((call) => ({
          id: String(call._id || call.callSid || ''),
          callSid: call.callSid || '',
          phoneNumber: call.phoneNumber || call.from || call.to || '-',
          type: this.resolveCallType(call),
          callType: this.resolveCallType(call),
          status: call.status || 'unknown',
          duration: Number(call.duration || 0),
          provider: call.provider || '',
          campaignName: call.providerData?.campaignName || call.providerData?.templateName || '',
          createdAt: call.createdAt,
          updatedAt: call.updatedAt,
          source: 'call'
        }))
        .filter(matchesRequestedType));
    }

    if (this.shouldIncludeBroadcastModel(callType)) {
      const broadcastCalls = await BroadcastCall.find(this.buildBroadcastMatch(dateRange, status, userId))
        .populate('broadcast', 'name campaignType')
        .sort({ createdAt: -1 })
        .limit(safeLimit)
        .select('callSid contact status duration createdAt updatedAt broadcast attempts twilioError')
        .lean();

      rows.push(...broadcastCalls.map((call) => ({
        id: String(call._id || call.callSid || ''),
        callSid: call.callSid || '',
        phoneNumber: call.contact?.phone || '-',
        contactName: call.contact?.name || '',
        type: 'voiceBroadcast',
        callType: 'voiceBroadcast',
        status: String(call.status || 'unknown').replace(/_/g, '-'),
        duration: Number(call.duration || 0),
        provider: 'twilio',
        campaignName: call.broadcast?.name || '',
        campaignType: call.broadcast?.campaignType || '',
        attempts: Number(call.attempts || 0),
        error: call.twilioError || null,
        createdAt: call.createdAt,
        updatedAt: call.updatedAt,
        source: 'broadcast'
      })));
    }

    return rows
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, safeLimit);
  }

  getEmptyChannelMetrics() {
    return {
      total: 0,
      active: 0,
      completed: 0,
      failed: 0,
      missed: 0,
      avgDuration: 0,
      totalDuration: 0,
      successRate: 0
    };
  }

  getEmptyChannels() {
    return {
      voiceBroadcast: this.getEmptyChannelMetrics(),
      inbound: this.getEmptyChannelMetrics(),
      ivr: this.getEmptyChannelMetrics(),
      inboundIvr: this.getEmptyChannelMetrics(),
      outbound: this.getEmptyChannelMetrics()
    };
  }

  mergeMetricBucket(target, source = {}) {
    const total = Number(source.total || 0);
    const totalDuration = Number(source.totalDuration || 0);

    target.total += total;
    target.active += Number(source.active || 0);
    target.completed += Number(source.completed || 0);
    target.failed += Number(source.failed || 0);
    target.missed += Number(source.missed || 0);
    target.totalDuration += totalDuration;
    target.avgDuration = target.total > 0 ? Math.round(target.totalDuration / target.total) : 0;
    target.successRate = target.total > 0 ? Math.round((target.completed / target.total) * 100) : 0;
  }

  buildCallMatch(dateRange, status = 'all', ownerFilter = {}) {
    const matchStage = {
      ...ownerFilter,
      createdAt: { $gte: dateRange.start, $lte: dateRange.end }
    };

    if (status && status !== 'all') {
      if (status === 'missed') {
        matchStage.status = { $in: ['busy', 'no-answer', 'missed', 'abandoned'] };
      } else if (status === 'failed') {
        matchStage.status = { $in: ['failed', 'busy', 'no-answer', 'cancelled', 'canceled'] };
      } else if (status === 'active') {
        matchStage.status = { $in: ['initiated', 'ringing', 'answered', 'in-progress'] };
      } else {
        matchStage.status = status;
      }
    }

    return matchStage;
  }

  buildBroadcastMatch(dateRange, status = 'all', userId = null) {
    const matchStage = {
      ...(userId ? { userId: this.toObjectId(userId) } : {}),
      createdAt: { $gte: dateRange.start, $lte: dateRange.end }
    };

    if (status && status !== 'all') {
      if (status === 'missed') {
        matchStage.status = { $in: ['busy', 'no_answer', 'missed', 'abandoned'] };
      } else if (status === 'failed') {
        matchStage.status = { $in: ['failed', 'busy', 'no_answer', 'cancelled'] };
      } else if (status === 'active') {
        matchStage.status = { $in: ['queued', 'claiming', 'calling', 'ringing', 'in_progress', 'answered'] };
      } else {
        matchStage.status = status;
      }
    }

    return matchStage;
  }

  getComputedCallTypeStage() {
    return {
      $addFields: {
        computedCallType: {
          $cond: [
            { $eq: ['$direction', 'outbound-local'] },
            'outbound',
            {
              $cond: [
                { $eq: ['$direction', 'outbound'] },
                'outbound',
                {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$direction', 'inbound'] },
                        { $ne: [{ $ifNull: ['$routing', 'default'] }, 'default'] }
                      ]
                    },
                    'ivr',
                    'inbound'
                  ]
                }
              ]
            }
          ]
        }
      }
    };
  }

  applyCallTypeFilter(pipeline, callType) {
    if (!callType || callType === 'all' || callType === 'voiceBroadcast') return;
    if (callType === 'inboundIvr') {
      pipeline.push({ $match: { computedCallType: { $in: ['inbound', 'ivr'] } } });
      return;
    }
    pipeline.push({ $match: { computedCallType: callType } });
  }

  shouldIncludeCallModel(callType) {
    return !callType || callType === 'all' || ['inbound', 'ivr', 'inboundIvr', 'outbound'].includes(callType);
  }

  shouldIncludeBroadcastModel(callType) {
    return !callType || callType === 'all' || callType === 'voiceBroadcast';
  }

  toObjectId(value) {
    if (!value) return value;
    return mongoose.Types.ObjectId.isValid(String(value))
      ? new mongoose.Types.ObjectId(String(value))
      : value;
  }

  async enforceInboundRecentCallsRetention(userId, limit = 100) {
    if (!userId || !Number.isFinite(Number(limit)) || Number(limit) <= 0) return 0;

    const staleRows = await Call.find({
      user: userId,
      direction: 'inbound',
      deletedAt: null
    })
      .sort({ createdAt: -1, _id: -1 })
      .skip(Math.floor(Number(limit)))
      .select('_id')
      .lean();

    if (!staleRows.length) return 0;

    const staleIds = staleRows.map((row) => row._id).filter(Boolean);
    const result = await Call.deleteMany({ _id: { $in: staleIds } });

    logger.info('[Analytics] Deleted stale inbound call records beyond retention limit', {
      userId: String(userId),
      limit: Math.floor(Number(limit)),
      deletedCount: result.deletedCount || 0
    });

    return result.deletedCount || 0;
  }

  /**
   * Get daily breakdown
   */
  async getDailyBreakdown(period, ownerFilter = {}) {
    const days = period === 'week' ? 7 : period === 'month' ? 30 : 1;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const data = await Call.aggregate([
      {
        $match: {
          ...ownerFilter,
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: VOICE_TIME_ZONE }
          },
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          failed: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
          }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const breakdown = {};
    data.forEach(d => {
      breakdown[d._id] = {
        total: d.total,
        completed: d.completed,
        failed: d.failed
      };
    });

    return breakdown;
  }

  async getUnifiedDailyBreakdown(period, callType = 'all', status = 'all', ownerFilter = {}, userId = null) {
    const dateRange = this.getDateRange(period);
    const breakdown = {};

    const ensureDay = (dateKey) => {
      if (!breakdown[dateKey]) {
        breakdown[dateKey] = {
          total: 0,
          completed: 0,
          failed: 0,
          inbound: 0,
          ivr: 0,
          inboundIvr: 0,
          outbound: 0,
          voiceBroadcast: 0,
          successRate: 0
        };
      }
      return breakdown[dateKey];
    };

    if (this.shouldIncludeCallModel(callType)) {
      const callPipeline = [
        { $match: this.buildCallMatch(dateRange, status, ownerFilter) },
        this.getComputedCallTypeStage()
      ];
      this.applyCallTypeFilter(callPipeline, callType);
      callPipeline.push(
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: VOICE_TIME_ZONE } },
              type: '$computedCallType'
            },
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'busy', 'no-answer', 'cancelled', 'canceled']] }, 1, 0] } }
          }
        },
        { $sort: { '_id.date': 1 } }
      );

      const callRows = await Call.aggregate(callPipeline);
      callRows.forEach((row) => {
        const day = ensureDay(row._id.date);
        const type = row._id.type;
        if (Object.prototype.hasOwnProperty.call(day, type)) {
          day[type] += row.total;
        }
        day.total += row.total;
        day.completed += row.completed;
        day.failed += row.failed;
      });
    }

    if (this.shouldIncludeBroadcastModel(callType)) {
      const broadcastRows = await BroadcastCall.aggregate([
        { $match: this.buildBroadcastMatch(dateRange, status, userId) },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: VOICE_TIME_ZONE } },
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'busy', 'no_answer', 'cancelled', 'opted_out']] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      broadcastRows.forEach((row) => {
        const day = ensureDay(row._id);
        day.voiceBroadcast += row.total;
        day.total += row.total;
        day.completed += row.completed;
        day.failed += row.failed;
      });
    }

    Object.values(breakdown).forEach((day) => {
      day.inboundIvr = day.inbound + day.ivr;
      day.successRate = day.total > 0 ? Math.round((day.completed / day.total) * 100) : 0;
    });

    return breakdown;
  }

  /**
   * Export analytics data
   */
  async exportAnalytics(req, res) {
    try {
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const { period = 'today', format = 'csv' } = req.query;
      const dateRange = this.getDateRange(period);

      const calls = await Call.find({
        user: userId,
        createdAt: { $gte: dateRange.start, $lte: dateRange.end }
      })
        .sort({ createdAt: -1 })
        .lean();

      if (format === 'csv') {
        const csv = this.convertToCSV(calls);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=analytics-${period}.csv`);
        return res.send(csv);
      }

      res.json({
        success: true,
        data: calls,
        count: calls.length
      });

    } catch (error) {
      logger.error('[Analytics] Export failed:', error);
      res.status(500).json({
        success: false,
        error: 'Export failed',
        message: error.message
      });
    }
  }

  /**
   * Broadcast analytics update to all connected clients
   */
  async broadcastAnalyticsUpdate() {
    try {
      await this.broadcastAnalyticsSnapshot({ period: 'today' });
    } catch (error) {
      logger.error('[Analytics] Broadcast failed:', error);
    }
  }

  /**
   * Handle call event and broadcast updates
   */
  async handleCallEvent(callData) {
    try {
      const io = getIO();
      if (!io) return;
      const userId = callData?.userId ? String(callData.userId) : null;
      const analyticsRoom = this.getAnalyticsRoom(userId);

      this.clearCache();

      // Broadcast to analytics room
      io.to(analyticsRoom).emit('call_event', {
        type: callData.event,
        call: callData,
        timestamp: new Date().toISOString()
      });

      // Trigger analytics refresh for significant events
      if (['call_started', 'call_created', 'call_updated', 'call_ended'].includes(callData.event)) {
        this.scheduleAnalyticsBroadcast({
          ...(callData.period ? { period: callData.period } : {}),
          reason: callData.event,
          userId
        });
      }
    } catch (error) {
      logger.error('[Analytics] Call event handling failed:', error);
    }
  }

  resolveCallType(call) {
    if (!call) return 'inbound';
    if (call.direction === 'outbound-local') return 'outbound_quickcalls';
    if (call.direction === 'outbound') return 'outbound';
    if (call.routing && call.routing !== 'default') return 'ivr';
    return 'inbound';
  }

  async emitAnalyticsSnapshotToSocket(socket, payload = {}) {
    if (!socket) return;
    const socketUserId = payload.userId || getRawUserId(socket.user);
    const { period, callType, status, userId } = this.normalizeAnalyticsPayload(payload, socketUserId);
    this.registerAnalyticsSubscription(socket, { period, callType, status, userId });
    const analytics = await this.getOrGenerateInboundAnalytics({ period, callType, status, userId });

    socket.emit('call_analytics_update', {
      type: 'snapshot',
      period,
      callType,
      status,
      userId,
      analytics,
      timestamp: new Date().toISOString()
    });
  }

  async broadcastAnalyticsSnapshot(payload = {}) {
    const io = getIO();
    if (!io) return;

    const { period, callType, status, userId } = this.normalizeAnalyticsPayload(payload);
    const analytics = await this.getOrGenerateInboundAnalytics({ period, callType, status, userId });
    const analyticsRoom = this.getAnalyticsRoom(userId);

    io.to(analyticsRoom).emit('call_analytics_update', {
      type: 'snapshot',
      period,
      callType,
      status,
      userId,
      reason: payload.reason || 'broadcast',
      analytics,
      timestamp: new Date().toISOString()
    });
  }

  scheduleAnalyticsBroadcast(payload = {}) {
    const targets = this.getActiveBroadcastTargets(payload);
    targets.forEach((target) => {
      this.pendingBroadcastKeys.set(this.buildSubscriptionKey(target), {
        ...target,
        reason: payload.reason || target.reason || 'broadcast'
      });
    });

    if (this.broadcastTimer) {
      return;
    }

    this.broadcastTimer = setTimeout(async () => {
      const nextPayloads = [...this.pendingBroadcastKeys.values()];
      this.broadcastTimer = null;
      this.pendingBroadcastKeys.clear();

      try {
        await Promise.all(nextPayloads.map((nextPayload) => this.broadcastAnalyticsSnapshot(nextPayload)));
      } catch (error) {
        logger.error('[Analytics] Scheduled broadcast failed:', error);
      }
    }, this.broadcastDebounceMs);
  }

  // Helper methods
  getDateRange(period) {
    return getDateRangeInTimezone(period, VOICE_TIME_ZONE);
  }

  async getAvgHandleTime() {
    const result = await Call.aggregate([
      { $match: { status: 'completed', agentId: { $exists: true } } },
      { $group: { _id: null, avg: { $avg: '$duration' } } }
    ]);
    return result[0]?.avg || 0;
  }

  async getAgentUtilization() {
    const [active, total] = await Promise.all([
      User.countDocuments({ role: 'agent', status: 'online' }),
      User.countDocuments({ role: 'agent' })
    ]);
    return total > 0 ? Math.round((active / total) * 100) : 0;
  }

  async getIVRContainmentRate(dateRange, userId = null) {
    const result = await ExecutionLog.aggregate([
      { $match: { startTime: { $gte: dateRange.start, $lte: dateRange.end }, ...(userId ? { userId } : {}) } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          contained: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          }
        }
      }
    ]);
    if (result.length === 0) return 0;
    return Math.round((result[0].contained / result[0].total) * 100);
  }

  async getIVRAbandonRate(dateRange, userId = null) {
    const result = await ExecutionLog.aggregate([
      { $match: { startTime: { $gte: dateRange.start, $lte: dateRange.end }, ...(userId ? { userId } : {}) } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          abandoned: {
            $sum: { $cond: [{ $eq: ['$status', 'abandoned'] }, 1, 0] }
          }
        }
      }
    ]);
    if (result.length === 0) return 0;
    return Math.round((result[0].abandoned / result[0].total) * 100);
  }

  async getIVRAvgDuration(dateRange, userId = null) {
    const result = await ExecutionLog.aggregate([
      { $match: { startTime: { $gte: dateRange.start, $lte: dateRange.end }, ...(userId ? { userId } : {}) } },
      { $group: { _id: null, avg: { $avg: '$duration' } } }
    ]);
    return result[0]?.avg || 0;
  }

  async getIVRTransferRate(dateRange, userId = null) {
    const result = await ExecutionLog.aggregate([
      { $match: { startTime: { $gte: dateRange.start, $lte: dateRange.end }, ...(userId ? { userId } : {}) } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          transferred: {
            $sum: { $cond: [{ $eq: ['$transferred', true] }, 1, 0] }
          }
        }
      }
    ]);
    if (result.length === 0) return 0;
    return Math.round((result[0].transferred / result[0].total) * 100);
  }

  convertToCSV(data) {
    if (data.length === 0) return '';
    
    const headers = Object.keys(data[0]);
    const rows = data.map(row => 
      headers.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return `"${String(val).replace(/"/g, '""')}"`;
      }).join(',')
    );
    
    return [headers.join(','), ...rows].join('\n');
  }

  clearCache() {
    this.cacheVersion += 1;
    this.cache.clear();
    this.inFlightAnalytics.clear();
    logger.info('[Analytics] Cache cleared');
  }

  clearUserCache(userId) {
    if (!userId) return;
    this.cacheVersion += 1;
    const userToken = `analytics_${String(userId)}_`;

    for (const key of this.cache.keys()) {
      if (key.startsWith(userToken)) {
        this.cache.delete(key);
      }
    }

    for (const key of this.inFlightAnalytics.keys()) {
      if (key.startsWith(userToken)) {
        this.inFlightAnalytics.delete(key);
      }
    }
  }
}

export default new AnalyticsController();

