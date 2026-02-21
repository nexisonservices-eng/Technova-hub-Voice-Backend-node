import Call from '../models/call.js';
import ExecutionLog from '../models/ExecutionLog.js';
import Workflow from '../models/Workflow.js';
import User from '../models/user.js';
import logger from '../utils/logger.js';
import { getIO } from '../sockets/unifiedSocket.js';

/**
 * Production-level Analytics Controller
 * Handles comprehensive call analytics with caching and real-time updates
 */
class AnalyticsController {
  constructor() {
    this.cache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.ANALYTICS_ROOM = 'analytics_room';
    this.broadcastDebounceMs = 500;
    this.broadcastTimer = null;
    this.pendingBroadcastPayload = null;
  }

  /**
   * Get comprehensive inbound analytics
   */
  async getInboundAnalytics(req, res) {
    try {
      const { period = 'today', callType = 'all', status = 'all' } = req.query;
      const analyticsData = await this.getOrGenerateInboundAnalytics({ period, callType, status });

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

  buildCacheKey(period = 'today', callType = 'all', status = 'all') {
    return `analytics_${period}_${callType}_${status}`;
  }

  async getOrGenerateInboundAnalytics({ period = 'today', callType = 'all', status = 'all' } = {}) {
    const normalizedPeriod = period || 'today';
    const normalizedCallType = callType || 'all';
    const normalizedStatus = status || 'all';
    const cacheKey = this.buildCacheKey(normalizedPeriod, normalizedCallType, normalizedStatus);

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    const analyticsData = await this.generateInboundAnalytics({
      period: normalizedPeriod,
      callType: normalizedCallType,
      status: normalizedStatus
    });

    this.cache.set(cacheKey, {
      data: analyticsData,
      timestamp: Date.now()
    });

    return analyticsData;
  }

  async generateInboundAnalytics({ period = 'today', callType = 'all', status = 'all' } = {}) {
    const dateRange = this.getDateRange(period);

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
      this.getSummaryStats(dateRange, callType, status),
      this.getHourlyDistribution(dateRange),
      this.getIVRBreakdown(dateRange),
      this.getAIMetrics(dateRange),
      this.getUsersStats(),
      this.getIVRStats(dateRange),
      this.getQueueStats(dateRange),
      this.getRecentCalls(dateRange, 50),
      this.getDailyBreakdown(period)
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
  async getSummaryStats(dateRange, callType, status) {
    const matchStage = {
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
  async getHourlyDistribution(dateRange) {
    const data = await Call.aggregate([
      {
        $match: {
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
  async getIVRBreakdown(dateRange) {
    const data = await ExecutionLog.aggregate([
      {
        $match: {
          startTime: { $gte: dateRange.start, $lte: dateRange.end }
        }
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
  async getAIMetrics(dateRange) {
    const aiCalls = await Call.aggregate([
      {
        $match: {
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
  async getIVRStats(dateRange) {
    const [containment, abandon, avgDuration, transfer] = await Promise.all([
      this.getIVRContainmentRate(dateRange),
      this.getIVRAbandonRate(dateRange),
      this.getIVRAvgDuration(dateRange),
      this.getIVRTransferRate(dateRange)
    ]);

    // Get flow performance
    const flows = await ExecutionLog.aggregate([
      {
        $match: {
          startTime: { $gte: dateRange.start, $lte: dateRange.end }
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
  async getQueueStats(dateRange) {
    const stats = await Call.aggregate([
      {
        $match: {
          createdAt: { $gte: dateRange.start, $lte: dateRange.end },
          queued: true
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
      status: 'queued',
      createdAt: { $gte: new Date(Date.now() - 3600000) }
    });
    result.longestQueue = currentQueue;

    return result;
  }

  /**
   * Get recent calls
   */
  async getRecentCalls(dateRange, limit = 50) {
    const rows = await Call.find({
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
  async getDailyBreakdown(period) {
    const days = period === 'week' ? 7 : period === 'month' ? 30 : 1;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const data = await Call.aggregate([
      {
        $match: {
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
      const { period = 'today', format = 'csv' } = req.query;
      const dateRange = this.getDateRange(period);

      const calls = await Call.find({
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

      this.clearCache();

      // Broadcast to analytics room
      io.to(this.ANALYTICS_ROOM).emit('call_event', {
        type: callData.event,
        call: callData,
        timestamp: new Date().toISOString()
      });

      // Trigger analytics refresh for significant events
      if (['call_ended', 'call_updated'].includes(callData.event)) {
        this.scheduleAnalyticsBroadcast({
          period: callData.period || 'today',
          reason: callData.event
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
    const analytics = await this.getOrGenerateInboundAnalytics({ period, callType, status });

    socket.emit('call_analytics_update', {
      type: 'snapshot',
      period,
      callType,
      status,
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
    const analytics = await this.getOrGenerateInboundAnalytics({ period, callType, status });

    io.to(this.ANALYTICS_ROOM).emit('call_analytics_update', {
      type: 'snapshot',
      period,
      callType,
      status,
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

  async getIVRContainmentRate(dateRange) {
    const result = await ExecutionLog.aggregate([
      { $match: { startTime: { $gte: dateRange.start, $lte: dateRange.end } } },
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

  async getIVRAbandonRate(dateRange) {
    const result = await ExecutionLog.aggregate([
      { $match: { startTime: { $gte: dateRange.start, $lte: dateRange.end } } },
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

  async getIVRAvgDuration(dateRange) {
    const result = await ExecutionLog.aggregate([
      { $match: { startTime: { $gte: dateRange.start, $lte: dateRange.end } } },
      { $group: { _id: null, avg: { $avg: '$duration' } } }
    ]);
    return result[0]?.avg || 0;
  }

  async getIVRTransferRate(dateRange) {
    const result = await ExecutionLog.aggregate([
      { $match: { startTime: { $gte: dateRange.start, $lte: dateRange.end } } },
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
