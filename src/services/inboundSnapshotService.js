import Call from '../models/call.js';
import Lead from '../models/Lead.js';
import InboundRoutingRule from '../models/InboundRoutingRule.js';
import { buildIVRMenuListPayload } from './ivrMenuSnapshotService.js';

const ACTIVE_CALL_STATUSES = ['initiated', 'ringing', 'in-progress'];
const DEFAULT_QUEUE_HANDLE_TIME_SECONDS = 300;
const RECENT_CALLS_LIMIT = 100;

const normalizeQueueName = (value) => {
  const queueName = String(value || '').trim();
  return queueName || 'General';
};

const toQueueTimestamp = (call) => (
  call?.queueEnteredAt ||
  call?.providerData?.queueEnteredAt ||
  call?.updatedAt ||
  call?.createdAt ||
  new Date()
);

export const mapRoutingRuleResponse = (rule) => ({
  id: String(rule._id),
  name: rule.name,
  priority: rule.priority,
  condition: rule.condition,
  action: rule.action,
  actionType: rule.actionType || 'custom',
  ivrMenuId: rule.ivrMenuId || '',
  ivrPromptKey: rule.ivrPromptKey || '',
  enabled: Boolean(rule.enabled)
});

export const buildQueueSnapshotPayload = async (userId, queueName = '') => {
  const filter = {
    user: userId,
    direction: 'inbound',
    queued: true,
    deletedAt: null
  };

  if (queueName) {
    filter.queueName = normalizeQueueName(queueName);
  }

  const calls = await Call.find(filter)
    .select('callSid phoneNumber providerData queueName queueEnteredAt queuePosition queueWaitTime status createdAt updatedAt')
    .sort({ queueName: 1, queuePosition: 1, queueEnteredAt: 1, createdAt: 1 })
    .lean();

  const grouped = {};

  calls.forEach((call) => {
    const name = normalizeQueueName(call.queueName);
    if (!grouped[name]) {
      grouped[name] = {
        name,
        length: 0,
        config: {
          averageHandleTimeSeconds: DEFAULT_QUEUE_HANDLE_TIME_SECONDS
        },
        calls: []
      };
    }

    const currentLength = grouped[name].calls.length;
    const position = Number.isFinite(Number(call.queuePosition)) && Number(call.queuePosition) > 0
      ? Number(call.queuePosition)
      : currentLength + 1;

    grouped[name].calls.push({
      callSid: call.callSid,
      phoneNumber: call.phoneNumber || call.providerData?.from || '',
      queuedAt: toQueueTimestamp(call),
      position,
      waitSeconds: Number.isFinite(Number(call.queueWaitTime)) ? Math.max(0, Number(call.queueWaitTime)) : 0,
      estimatedWaitTime: position * DEFAULT_QUEUE_HANDLE_TIME_SECONDS,
      status: call.status || 'in-progress'
    });
  });

  Object.values(grouped).forEach((queue) => {
    queue.calls.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      return new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime();
    });

    queue.calls = queue.calls.map((caller, index) => ({
      ...caller,
      position: index + 1,
      estimatedWaitTime: (index + 1) * DEFAULT_QUEUE_HANDLE_TIME_SECONDS
    }));
    queue.length = queue.calls.length;
  });

  return grouped;
};

export const buildInboundOverviewPayload = async (userId, period = 'today') => {
  const now = new Date();
  let startDate = new Date(now);

  if (period === 'week') {
    startDate.setDate(now.getDate() - 7);
  } else if (period === 'month') {
    startDate.setMonth(now.getMonth() - 1);
  } else if (period === 'year') {
    startDate.setFullYear(now.getFullYear() - 1);
  } else {
    startDate.setHours(0, 0, 0, 0);
  }

  const filter = {
    user: userId,
    direction: 'inbound',
    deletedAt: null,
    createdAt: { $gte: startDate }
  };

  const [totalCalls, completedCalls, activeCalls, recentCalls, durationAgg] = await Promise.all([
    Call.countDocuments(filter),
    Call.countDocuments({ ...filter, status: 'completed' }),
    Call.countDocuments({ ...filter, status: { $in: ACTIVE_CALL_STATUSES } }),
    Call.find(filter)
      .select('callSid phoneNumber status duration createdAt updatedAt')
      .sort({ createdAt: -1, _id: -1 })
      .limit(RECENT_CALLS_LIMIT)
      .lean(),
    Call.aggregate([
      { $match: { ...filter, status: 'completed' } },
      { $group: { _id: null, avgDuration: { $avg: '$duration' } } }
    ])
  ]);

  const answerRate = totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0;
  const avgDuration = Math.round(Number(durationAgg?.[0]?.avgDuration || 0));

  return {
    summary: {
      totalCalls,
      activeCalls,
      completedCalls,
      avgDuration,
      answerRate,
      successRate: answerRate
    },
    recentCalls
  };
};

export const buildRoutingRulesPayload = async (userId) => {
  const rules = await InboundRoutingRule.find({ userId })
    .sort({ priority: 1, updatedAt: -1 })
    .lean();

  return rules.map((rule) => mapRoutingRuleResponse(rule));
};

export const buildLeadsSummaryPayload = async (userId) => {
  const total = await Lead.countDocuments({ user: userId });
  return {
    contactsUsed: total,
    total
  };
};

export const buildInboundSnapshotPayload = async (userId, { period = 'today' } = {}) => {
  const [overview, queues, routingRules, ivrMenusPayload, leadsSummary] = await Promise.all([
    buildInboundOverviewPayload(userId, period),
    buildQueueSnapshotPayload(userId),
    buildRoutingRulesPayload(userId),
    buildIVRMenuListPayload(userId),
    buildLeadsSummaryPayload(userId)
  ]);

  return {
    success: true,
    overview,
    queues,
    queueStatus: queues,
    routingRules,
    ivrMenus: ivrMenusPayload.ivrMenus || [],
    leadsSummary,
    timestamp: new Date().toISOString()
  };
};
