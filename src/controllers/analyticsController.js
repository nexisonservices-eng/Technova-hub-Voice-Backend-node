import Call from '../models/call.js';
import BroadcastCall from '../models/BroadcastCall.js';
import ExecutionLog from '../models/ExecutionLog.js';
import Workflow from '../models/Workflow.js';
import User from '../models/user.js';
import logger from '../utils/logger.js';
import { getIO } from '../sockets/unifiedSocket.js';
import { getRawUserId, getUserObjectId } from '../utils/authContext.js';

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
    this.pendingBroadcastPayload = null;
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

  getAnalyticsRoom(userId = null) {
    const resolvedUserId = userId ? String(userId) : '';
    return resolvedUserId ? `${this.ANALYTICS_ROOM_PREFIX}${resolvedUserId}` : this.ANALYTICS_ROOM;
  }

  async getOrGenerateInboundAnalytics({ period = 'today', callType = 'all', status = 'all', userId = null } = {}) {
    const normalizedPeriod = period || 'today';
    const normalizedCallType = callType || 'all';
    const normalizedStatus = status || 'all';
    const cacheKey = this.buildCacheKey(normalizedPeriod, normalizedCallType, normalizedStatus, userId || 'anonymous');

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    const analyticsData = await this.generateInboundAnalytics({
      period: normalizedPeriod,
      callType: normalizedCallType,
      status: normalizedStatus,
      userId
    });

    this.cache.set(cacheKey, {
      data: analyticsData,
      timestamp: Date.now()
    });

    return analyticsData;
  }

  async generateInboundAnalytics({ period = 'today', callType = 'all', status = 'all', userId = null } = {}) {
    const dateRange = this.getDateRange(period);
    const ownerFilter = userId ? { user: userId } : {};

    const [
      summary,
      hourlyDistribution,
      ivrBreakdown,
      aiMetrics,
      users,
      ivr,
      queue,
      recentCalls,
      dailyBreakdown
    ] = await Promise.all([
      this.getSummaryStats(dateRange, callType, status, ownerFilter),
      this.getHourlyDistribution(dateRange, ownerFilter),
      this.getIVRBreakdown(dateRange, userId),
      this.getAIMetrics(dateRange, ownerFilter),
      this.getUsersStats(),
      this.getIVRStats(dateRange, userId),
      this.getQueueStats(dateRange, ownerFilter),
      this.getRecentCalls(dateRange, 50, ownerFilter),
      this.getDailyBreakdown(period, ownerFilter)
    ]);

    return {
      summary,
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
        }
      }
    ];

    if (callType && callType !== 'all') {
      pipeline.push({ $match: { computedCallType: callType } });
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
            $sum: { $cond: [{ $eq: ['$computedCallType', 'outbound'] }, 1, 0] }
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
          _id: { $hour: '$createdAt' },
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
  async getRecentCalls(dateRange, limit = 50, ownerFilter = {}) {
    const rows = await Call.find({
      ...ownerFilter,
      createdAt: { $gte: dateRange.start, $lte: dateRange.end }
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
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
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
      if (['call_ended', 'call_updated'].includes(callData.event)) {
        this.scheduleAnalyticsBroadcast({
          period: callData.period || 'today',
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
    if (call.direction === 'outbound') return 'outbound';
    if (call.routing && call.routing !== 'default') return 'ivr';
    return 'inbound';
  }

  async emitAnalyticsSnapshotToSocket(socket, payload = {}) {
    if (!socket) return;
    const period = payload.period || 'today';
    const callType = payload.callType || 'all';
    const status = payload.status || 'all';
    const socketUserId = payload.userId || getRawUserId(socket.user);
    const userId = socketUserId ? String(socketUserId) : null;
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

    const period = payload.period || 'today';
    const callType = payload.callType || 'all';
    const status = payload.status || 'all';
    const userId = payload.userId ? String(payload.userId) : null;
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
    this.pendingBroadcastPayload = {
      ...(this.pendingBroadcastPayload || {}),
      ...payload
    };

    if (this.broadcastTimer) {
      return;
    }

    this.broadcastTimer = setTimeout(async () => {
      const nextPayload = this.pendingBroadcastPayload || {};
      this.broadcastTimer = null;
      this.pendingBroadcastPayload = null;

      try {
        await this.broadcastAnalyticsSnapshot(nextPayload);
      } catch (error) {
        logger.error('[Analytics] Scheduled broadcast failed:', error);
      }
    }, this.broadcastDebounceMs);
  }

  // Helper methods
  getDateRange(period) {
    const end = new Date();
    const start = new Date();

    switch (period) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case 'week':
        start.setDate(start.getDate() - 7);
        break;
      case 'month':
        start.setMonth(start.getMonth() - 1);
        break;
      case 'year':
        start.setFullYear(start.getFullYear() - 1);
        break;
      case 'yesterday':
        start.setDate(start.getDate() - 1);
        start.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() - 1);
        end.setHours(23, 59, 59, 999);
        break;
      case 'last_week':
        start.setDate(start.getDate() - 14);
        end.setDate(end.getDate() - 7);
        break;
      case 'last_month':
        start.setMonth(start.getMonth() - 2);
        end.setMonth(end.getMonth() - 1);
        break;
      default:
        start.setHours(0, 0, 0, 0);
    }

    return { start, end };
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
    this.cache.clear();
    logger.info('[Analytics] Cache cleared');
  }
}

export default new AnalyticsController();
