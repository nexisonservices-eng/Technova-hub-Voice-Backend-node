import logger from '../utils/logger.js';
import Call from '../models/call.js';
import User from '../models/user.js';
import inboundCallService from './inboundCallService.js';

class CallAnalyticsService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    logger.info('✓ Call Analytics Service Initialized');
  }

  /* =========================
     Get Comprehensive Analytics
  ========================== */
  async getAnalytics(period = 'today', filters = {}) {
    try {
      const cacheKey = `analytics_${period}_${JSON.stringify(filters)}`;

      // Check cache
      if (this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          return cached.data;
        }
      }

      const dateRange = this.getDateRange(period);

      // Base query
      let query = {
        createdAt: { $gte: dateRange.start, $lte: dateRange.end }
      };

      // Apply filters
      if (filters.direction) {
        query.direction = filters.direction;
      }
      if (filters.status) {
        query.status = filters.status;
      }
      if (filters.provider) {
        query.provider = filters.provider;
      }

      // Fetch calls
      const calls = await Call.find(query)
        .populate('user', 'name phone vip')
        .sort({ createdAt: -1 });

      // Calculate metrics
      const analytics = this.calculateMetrics(calls, period);

      // Add queue analytics
      analytics.queues = inboundCallService.getAllQueueStatus();

      // Add user analytics
      analytics.users = await this.getUserAnalytics(dateRange);

      // Cache results
      this.cache.set(cacheKey, {
        data: analytics,
        timestamp: Date.now()
      });

      return analytics;

    } catch (error) {
      logger.error('Get analytics error:', error);
      throw error;
    }
  }

  /* =========================
     Calculate Call Metrics
  ========================== */
  calculateMetrics(calls, period) {
    const totalCalls = calls.length;
    const inboundCalls = calls.filter(c => c.direction === 'inbound');
    const outboundCalls = calls.filter(c => c.direction === 'outbound');

    const completedCalls = calls.filter(c => c.status === 'completed');
    const failedCalls = calls.filter(c => c.status === 'failed');
    const missedCalls = calls.filter(c => c.status === 'no-answer' || c.status === 'busy');

    // Duration metrics
    const answeredCalls = completedCalls.filter(c => c.duration > 0);
    const avgDuration = answeredCalls.length > 0
      ? Math.round(answeredCalls.reduce((sum, c) => sum + c.duration, 0) / answeredCalls.length)
      : 0;

    const totalDuration = answeredCalls.reduce((sum, c) => sum + c.duration, 0);

    // Success rates
    const successRate = totalCalls > 0 ? Math.round((completedCalls.length / totalCalls) * 100) : 0;
    const answerRate = totalCalls > 0 ? Math.round((answeredCalls.length / totalCalls) * 100) : 0;

    // AI metrics
    const aiCalls = calls.filter(c => c.conversation && c.conversation.length > 0);
    const avgAIResponseTime = this.calculateAvgAIResponseTime(aiCalls);

    // IVR analytics
    const ivrAnalytics = this.getIVRAnalytics(calls);

    // Hourly breakdown
    const hourlyBreakdown = this.getHourlyBreakdown(calls);

    // Daily breakdown (for week/month views)
    const dailyBreakdown = period !== 'today' ? this.getDailyBreakdown(calls) : null;

    return {
      period,
      summary: {
        totalCalls,
        inboundCalls: inboundCalls.length,
        outboundCalls: outboundCalls.length,
        completedCalls: completedCalls.length,
        failedCalls: failedCalls.length,
        missedCalls: missedCalls.length,
        successRate,
        answerRate,
        avgDuration,
        totalDuration
      },
      aiMetrics: {
        aiCalls: aiCalls.length,
        aiEngagementRate: totalCalls > 0 ? Math.round((aiCalls.length / totalCalls) * 100) : 0,
        avgResponseTime: avgAIResponseTime,
        totalExchanges: aiCalls.reduce((sum, c) => sum + (c.aiMetrics?.totalExchanges || 0), 0)
      },
      ivrAnalytics,
      hourlyBreakdown,
      dailyBreakdown,
      topPerformers: this.getTopPerformers(calls),
      recentCalls: calls.slice(0, 10).map(this.formatCallSummary)
    };
  }

  /* =========================
     Get IVR Analytics
  ========================== */
  getIVRAnalytics(calls) {
    const ivrCalls = calls.filter(c => c.routing && c.routing !== 'default');

    const routingBreakdown = {};
    const menuBreakdown = {};

    ivrCalls.forEach(call => {
      // Routing breakdown
      const routing = call.routing || 'unknown';
      routingBreakdown[routing] = (routingBreakdown[routing] || 0) + 1;

      // Menu interactions (from conversation analysis)
      if (call.conversation) {
        call.conversation.forEach(msg => {
          if (msg.type === 'system' && msg.text.includes('pressed')) {
            // Extract menu selection
            const match = msg.text.match(/pressed (\d)/);
            if (match) {
              const key = match[1];
              menuBreakdown[key] = (menuBreakdown[key] || 0) + 1;
            }
          }
        });
      }
    });

    return {
      totalIVRCalls: ivrCalls.length,
      ivrUsageRate: calls.length > 0 ? Math.round((ivrCalls.length / calls.length) * 100) : 0,
      routingBreakdown,
      menuBreakdown,
      avgMenuTime: this.calculateAvgMenuTime(ivrCalls)
    };
  }

  /* =========================
     Get Hourly Breakdown
  ========================== */
  getHourlyBreakdown(calls) {
    const hourly = {};

    for (let hour = 0; hour < 24; hour++) {
      hourly[hour] = {
        total: 0,
        inbound: 0,
        outbound: 0,
        completed: 0
      };
    }

    calls.forEach(call => {
      const hour = new Date(call.createdAt).getHours();
      hourly[hour].total++;
      hourly[hour][call.direction]++;
      if (call.status === 'completed') {
        hourly[hour].completed++;
      }
    });

    return hourly;
  }

  /* =========================
     Get Daily Breakdown
  ========================== */
  getDailyBreakdown(calls) {
    const daily = {};

    calls.forEach(call => {
      const date = new Date(call.createdAt).toISOString().split('T')[0];
      if (!daily[date]) {
        daily[date] = {
          total: 0,
          inbound: 0,
          outbound: 0,
          completed: 0,
          duration: 0
        };
      }

      daily[date].total++;
      daily[date][call.direction]++;
      if (call.status === 'completed') {
        daily[date].completed++;
        daily[date].duration += call.duration || 0;
      }
    });

    return daily;
  }

  /* =========================
     Get User Analytics
  ========================== */
  async getUserAnalytics(dateRange) {
    try {
      // Top callers
      const topCallers = await Call.aggregate([
        {
          $match: {
            createdAt: { $gte: dateRange.start, $lte: dateRange.end },
            user: { $exists: true }
          }
        },
        {
          $group: {
            _id: '$user',
            totalCalls: { $sum: 1 },
            totalDuration: { $sum: '$duration' },
            avgDuration: { $avg: '$duration' }
          }
        },
        {
          $sort: { totalCalls: -1 }
        },
        {
          $limit: 10
        },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'userInfo'
          }
        }
      ]);

      // VIP vs regular users
      const vipCalls = await Call.countDocuments({
        createdAt: { $gte: dateRange.start, $lte: dateRange.end },
        'user.vip': true
      });

      const regularCalls = await Call.countDocuments({
        createdAt: { $gte: dateRange.start, $lte: dateRange.end },
        'user.vip': false
      });

      return {
        topCallers: topCallers.map(item => ({
          userId: item._id,
          userInfo: item.userInfo[0],
          totalCalls: item.totalCalls,
          totalDuration: item.totalDuration,
          avgDuration: Math.round(item.avgDuration || 0)
        })),
        vipVsRegular: {
          vipCalls,
          regularCalls,
          vipPercentage: (vipCalls + regularCalls) > 0 ? Math.round((vipCalls / (vipCalls + regularCalls)) * 100) : 0
        }
      };

    } catch (error) {
      logger.error('User analytics error:', error);
      return { topCallers: [], vipVsRegular: { vipCalls: 0, regularCalls: 0, vipPercentage: 0 } };
    }
  }

  /* =========================
     Get Top Performers
  ========================= */
  getTopPerformers(calls) {
    // Best performing times
    const hourlyPerformance = this.getHourlyBreakdown(calls);
    const bestHour = Object.entries(hourlyPerformance)
      .filter(([_, data]) => data.total >= 5) // Minimum 5 calls
      .sort(([, a], [, b]) => (b.completed / b.total) - (a.completed / a.total))
      .slice(0, 3);

    // Most engaged users (by conversation length)
    const engagedUsers = calls
      .filter(c => c.conversation && c.conversation.length > 0)
      .sort((a, b) => (b.conversation?.length || 0) - (a.conversation?.length || 0))
      .slice(0, 5)
      .map(this.formatCallSummary);

    return {
      bestHours: bestHour.map(([hour, data]) => ({
        hour: parseInt(hour),
        totalCalls: data.total,
        successRate: Math.round((data.completed / data.total) * 100)
      })),
      mostEngaged: engagedUsers
    };
  }

  /* =========================
     Helper Methods
  ========================== */
  calculateAvgAIResponseTime(aiCalls) {
    if (aiCalls.length === 0) return 0;

    const totalResponseTime = aiCalls.reduce((sum, call) => {
      return sum + (call.aiMetrics?.avgResponseTime || 0);
    }, 0);

    return Math.round(totalResponseTime / aiCalls.length);
  }

  calculateAvgMenuTime(ivrCalls) {
    // This would need to be calculated from conversation timestamps
    // For now, return estimated value
    return ivrCalls.length > 0 ? 15 : 0; // seconds
  }

  formatCallSummary(call) {
    return {
      callSid: call.callSid,
      phoneNumber: call.phoneNumber,
      direction: call.direction,
      status: call.status,
      duration: call.duration,
      routing: call.routing,
      conversationLength: call.conversation?.length || 0,
      createdAt: call.createdAt,
      user: call.user ? {
        name: call.user.name,
        phone: call.user.phone,
        vip: call.user.vip
      } : null
    };
  }

  getDateRange(period) {
    const now = new Date();
    let start;

    switch (period) {
      case 'today':
        start = new Date(now);
        start.setHours(0, 0, 0, 0);
        break;
      case 'week':
        start = new Date(now);
        start.setDate(now.getDate() - 7);
        break;
      case 'month':
        start = new Date(now);
        start.setMonth(now.getMonth() - 1);
        break;
      case 'year':
        start = new Date(now);
        start.setFullYear(now.getFullYear() - 1);
        break;
      default:
        start = new Date(now);
        start.setHours(0, 0, 0, 0);
    }

    return { start, end: now };
  }

  /* =========================
     Real-time Metrics
  ========================== */
  async getRealTimeMetrics() {
    try {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const recentCalls = await Call.find({
        createdAt: { $gte: oneHourAgo }
      });

      const activeCalls = await Call.find({
        status: { $in: ['initiated', 'ringing', 'in-progress'] }
      });

      return {
        lastHour: {
          totalCalls: recentCalls.length,
          completedCalls: recentCalls.filter(c => c.status === 'completed').length,
          avgDuration: this.calculateAvgDuration(recentCalls.filter(c => c.duration > 0))
        },
        activeCalls: {
          total: activeCalls.length,
          inProgress: activeCalls.filter(c => c.status === 'in-progress').length,
          ringing: activeCalls.filter(c => c.status === 'ringing').length
        },
        queues: inboundCallService.getAllQueueStatus(),
        timestamp: now
      };

    } catch (error) {
      logger.error('Real-time metrics error:', error);
      throw error;
    }
  }

  calculateAvgDuration(calls) {
    if (calls.length === 0) return 0;
    const total = calls.reduce((sum, call) => sum + call.duration, 0);
    return Math.round(total / calls.length);
  }

  /* =========================
     Export Analytics
  ========================== */
  async exportAnalytics(period = 'today', format = 'json') {
    try {
      const analytics = await this.getAnalytics(period);

      switch (format.toLowerCase()) {
        case 'csv':
          return this.convertToCSV(analytics);
        case 'xlsx':
          return this.convertToXLSX(analytics);
        default:
          return analytics;
      }
    } catch (error) {
      logger.error('Export analytics error:', error);
      throw error;
    }
  }

  convertToCSV(analytics) {
    // CSV conversion logic
    const csv = [
      'Period,Total Calls,Inbound,Outbound,Completed,Success Rate,Avg Duration',
      `${analytics.period},${analytics.summary.totalCalls},${analytics.summary.inboundCalls},${analytics.summary.outboundCalls},${analytics.summary.completedCalls},${analytics.summary.successRate}%,${analytics.summary.avgDuration}s`
    ].join('\n');

    return csv;
  }

  convertToXLSX(analytics) {
    // XLSX conversion would require a library like xlsx
    // For now, return JSON
    return analytics;
  }
}

export default new CallAnalyticsService();
