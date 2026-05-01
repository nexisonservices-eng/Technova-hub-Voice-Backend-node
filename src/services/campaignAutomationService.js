import crypto from 'crypto';
import cron from 'node-cron';
import CampaignSchedule from '../models/CampaignSchedule.js';
import Broadcast from '../models/Broadcast.js';
import Call from '../models/call.js';
import exotelService from './ExotelService.js';
import logger from '../utils/logger.js';
import { parseScheduledDateInTimezone } from '../utils/timezoneDate.js';
import {
  emitCampaignUpdate,
  emitRetryStats,
  emitAbTestResults,
  emitOutboundMetrics
} from '../sockets/unifiedSocket.js';

const LOCAL_MOBILE_REGEX = /^\+91[6-9][0-9]{9}$/;
const RETRY_GAP_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const normalizeNumber = (value = '') => {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (LOCAL_MOBILE_REGEX.test(String(value).trim())) return String(value).trim();
  return null;
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getTimePartsInTimezone = (date, timezone = DEFAULT_TIMEZONE) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short'
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    year: parsePositiveInt(parts.year, date.getUTCFullYear()),
    month: parsePositiveInt(parts.month, date.getUTCMonth() + 1),
    day: parsePositiveInt(parts.day, date.getUTCDate()),
    hour: parsePositiveInt(parts.hour, date.getUTCHours()),
    minute: parsePositiveInt(parts.minute, date.getUTCMinutes()),
    second: parsePositiveInt(parts.second, date.getUTCSeconds()),
    weekday: weekdayMap[parts.weekday] ?? date.getUTCDay()
  };
};

class CampaignAutomationService {
  constructor() {
    this.tasks = new Map();
    this.executionLocks = new Set();
  }

  computeNextRunAt({ recurrence = 'once', timezone = DEFAULT_TIMEZONE, scheduledAt = null, allowedWindowStart = '09:00', fromDate = new Date() } = {}) {
    if (scheduledAt instanceof Date && !Number.isNaN(scheduledAt.getTime()) && recurrence === 'once') {
      return scheduledAt;
    }

    const [hourText = '9', minuteText = '0'] = String(allowedWindowStart || '09:00').split(':');
    const targetHour = parsePositiveInt(hourText, 9);
    const targetMinute = parsePositiveInt(minuteText, 0);
    const seed = fromDate instanceof Date && !Number.isNaN(fromDate.getTime()) ? new Date(fromDate) : new Date();

    const next = new Date(seed);
    next.setSeconds(0, 0);
    next.setMinutes(targetMinute);
    next.setHours(targetHour);

    const nextParts = getTimePartsInTimezone(next, timezone);
    const seedParts = getTimePartsInTimezone(seed, timezone);
    const nextMinutes = (nextParts.hour * 60) + nextParts.minute;
    const seedMinutes = (seedParts.hour * 60) + seedParts.minute;

    if (recurrence === 'weekly') {
      const targetWeekday = scheduledAt instanceof Date && !Number.isNaN(scheduledAt.getTime())
        ? getTimePartsInTimezone(scheduledAt, timezone).weekday
        : 1;
      let dayOffset = targetWeekday - seedParts.weekday;
      if (dayOffset < 0 || (dayOffset === 0 && nextMinutes <= seedMinutes)) {
        dayOffset += 7;
      }
      next.setDate(next.getDate() + dayOffset);
      return next;
    }

    if (nextMinutes <= seedMinutes) {
      next.setDate(next.getDate() + 1);
    }

    return next;
  }

  async initializeScheduledTasks() {
    const activeSchedules = await CampaignSchedule.find({ status: 'active' }).lean();
    for (const schedule of activeSchedules) {
      try {
        this.registerScheduleTask(schedule);
      } catch (error) {
        logger.error('Failed to re-register scheduled campaign on startup', {
          scheduleId: schedule._id,
          error: error.message
        });
      }
    }
    return activeSchedules.length;
  }

  validateCronExpression(cronExpression) {
    return cron.validate(String(cronExpression || '').trim());
  }

  async preventDuplicateSchedule({ userId, campaignName, cronExpression }) {
    const existing = await CampaignSchedule.findOne({
      userId,
      campaignName,
      cronExpression,
      status: { $in: ['active', 'paused'] }
    }).lean();

    if (existing) {
      throw new Error('Duplicate campaign schedule detected for same campaign name and cron expression.');
    }
  }

  async createSchedule(payload, userId) {
    const cronExpression = String(payload?.cronExpression || '').trim();
    if (!this.validateCronExpression(cronExpression)) {
      throw new Error('Invalid cron expression');
    }

    const normalizedNumbers = Array.from(
      new Set((payload?.numbers || []).map((n) => normalizeNumber(n)).filter(Boolean))
    );

    if (!normalizedNumbers.length) {
      throw new Error('No valid +91 campaign numbers provided');
    }

    await this.preventDuplicateSchedule({
      userId,
      campaignName: payload?.campaignName,
      cronExpression
    });

    const recurrence = payload?.recurrence || 'daily';
    const metadata = payload?.metadata || {};
    const allowedWindowStart = metadata?.allowedWindowStart || payload?.allowedWindowStart || '09:00';
    const timezone = String(payload?.timezone || DEFAULT_TIMEZONE);
    const scheduledAtRaw = metadata?.scheduledAt || metadata?.scheduledAtLocal || payload?.scheduledAt || null;
    const scheduledAt = parseScheduledDateInTimezone(scheduledAtRaw, timezone);
    const nextRunAt = this.computeNextRunAt({
      recurrence,
      timezone,
      scheduledAt,
      allowedWindowStart
    });

    const schedule = await CampaignSchedule.create({
      userId,
      campaignId: payload?.campaignId || `scheduled_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      campaignName: String(payload?.campaignName || 'Scheduled Outbound Campaign').trim(),
      numbers: normalizedNumbers,
      fromNumbers: Array.isArray(payload?.fromNumbers) ? payload.fromNumbers : [],
      cronExpression,
      timezone,
      recurrence,
      retryCount: 0,
      retryGapHours: Number(payload?.retryGapHours || 2),
      maxRetries: Number(payload?.maxRetries || 3),
      abTestEnabled: Boolean(payload?.abTestConfig?.enabled),
      abTestGroups: Array.isArray(payload?.abTestConfig?.groups) ? payload.abTestConfig.groups : [],
      nextRunAt,
      metadata: payload?.metadata || {}
    });

    this.registerScheduleTask(schedule);

    emitCampaignUpdate(String(userId), {
      action: 'scheduled',
      scheduleId: String(schedule._id),
      campaignId: schedule.campaignId,
      campaignName: schedule.campaignName,
      cronExpression: schedule.cronExpression,
      recurrence: schedule.recurrence
    });

    return schedule;
  }

  registerScheduleTask(scheduleDoc) {
    const scheduleId = String(scheduleDoc._id);

    if (this.tasks.has(scheduleId)) {
      this.tasks.get(scheduleId).stop();
      this.tasks.delete(scheduleId);
    }

    const task = exotelService.scheduleCampaigns({
      cronExpression: scheduleDoc.cronExpression,
      timezone: scheduleDoc.timezone || 'Asia/Kolkata',
      onTick: async () => {
        await this.executeScheduledCampaign(scheduleId);
      }
    });

    this.tasks.set(scheduleId, task);
    return task;
  }

  async executeScheduledCampaign(scheduleId) {
    const key = String(scheduleId);
    if (this.executionLocks.has(key)) {
      logger.warn('Skipping overlapping scheduled campaign execution', { scheduleId: key });
      return null;
    }

    this.executionLocks.add(key);

    try {
      const schedule = await CampaignSchedule.findById(scheduleId);
      if (!schedule || schedule.status !== 'active') return null;

      if (schedule?.metadata?.outboundCampaignId) {
        const { default: outboundCampaignService } = await import('./outboundCampaignService.js');
        const result = await outboundCampaignService.executeCampaignById(schedule.metadata.outboundCampaignId, {
          trigger: 'scheduled',
          scheduleId: String(schedule._id)
        });

        schedule.lastRunAt = new Date();
        schedule.nextRunAt = schedule.recurrence === 'once'
          ? null
          : this.computeNextRunAt({
              recurrence: schedule.recurrence,
              timezone: schedule.timezone,
              scheduledAt: parseScheduledDateInTimezone(
                schedule.metadata?.scheduledAt || schedule.metadata?.scheduledAtLocal,
                schedule.timezone
              ),
              allowedWindowStart: schedule.metadata?.allowedWindowStart || '09:00',
              fromDate: new Date()
            });
        if (schedule.recurrence === 'once') {
          schedule.status = 'completed';
        }
        await schedule.save();
        return result;
      }

      const userId = String(schedule.userId);
      const numbers = Array.isArray(schedule.numbers) ? schedule.numbers : [];

      let initiated = 0;
      let failed = 0;
      const abStats = {};

      let groups = [];
      if (schedule.abTestEnabled && schedule.abTestGroups.length >= 2) {
        const split = exotelService.abTest({
          numbers,
          templates: schedule.abTestGroups.map((group) => ({
            key: group.key,
            template: group.template
          }))
        });
        groups = split.groups;
      } else {
        groups = [{ key: 'default', template: '', numbers }];
      }

      for (const group of groups) {
        abStats[group.key] = { initiated: 0, failed: 0, template: group.template };

        for (const number of group.numbers) {
          const caller = exotelService.dynamicCallerId().callerId;
          try {
            const exotelCall = await exotelService.createOutboundLocalCall({
              to: number,
              from: caller,
              appParams: {
                campaignId: schedule.campaignId,
                scheduleId,
                abGroup: group.key,
                template: group.template
              }
            });

            await Call.create({
              callSid: exotelCall.callSid,
              exotelCallSid: exotelCall.callSid,
              user: schedule.userId,
              phoneNumber: number,
              direction: 'outbound-local',
              provider: 'exotel',
              status: 'initiated',
              retryAttempt: 0,
              startTime: new Date(),
              providerData: {
                campaignId: schedule.campaignId,
                scheduleId,
                abGroup: group.key,
                template: group.template,
                from: caller,
                exotel: exotelCall.raw
              }
            });

            initiated += 1;
            abStats[group.key].initiated += 1;
          } catch (error) {
            failed += 1;
            abStats[group.key].failed += 1;

            await Call.create({
              callSid: `failed_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
              user: schedule.userId,
              phoneNumber: number,
              direction: 'outbound-local',
              provider: 'exotel',
              status: 'failed',
              retryAttempt: 0,
              nextRetryAt: new Date(Date.now() + RETRY_GAP_MS),
              providerData: {
                campaignId: schedule.campaignId,
                scheduleId,
                abGroup: group.key,
                template: group.template,
                error: error.message
              },
              error: {
                message: error.message
              }
            });
          }
        }
      }

      const abGroupResults = Object.entries(abStats).map(([key, value]) => {
      const total = value.initiated + value.failed;
      return {
        key,
        template: value.template,
        initiated: value.initiated,
        failed: value.failed,
        successRate: total > 0 ? Number(((value.initiated / total) * 100).toFixed(2)) : 0
      };
    });

      const winner = abGroupResults.sort((a, b) => b.successRate - a.successRate)[0]?.key || '';

      schedule.lastRunAt = new Date();
      schedule.retryCount += failed > 0 ? 1 : 0;
      schedule.nextRunAt = schedule.recurrence === 'once'
        ? null
        : this.computeNextRunAt({
            recurrence: schedule.recurrence,
            timezone: schedule.timezone,
            allowedWindowStart: schedule.metadata?.allowedWindowStart || '09:00',
            fromDate: new Date()
          });
      if (schedule.recurrence === 'once') {
        schedule.status = 'completed';
      }
      if (winner) schedule.winnerGroup = winner;
      schedule.abTestGroups = abGroupResults.map((group) => ({
        key: group.key,
        template: group.template,
        allocated: group.initiated + group.failed,
        initiated: group.initiated,
        failed: group.failed
      }));
      await schedule.save();

      await Broadcast.updateOne(
      { createdBy: schedule.userId },
      {
        $set: {
          'scheduleConfig.enabled': true,
          'scheduleConfig.cronExpression': schedule.cronExpression,
          'scheduleConfig.recurrence': schedule.recurrence,
          'scheduleConfig.timezone': schedule.timezone,
          'scheduleConfig.lastScheduledAt': new Date(),
          'abTestConfig.enabled': schedule.abTestEnabled,
          'abTestConfig.winnerTemplate': winner
        }
      }
    );

      emitCampaignUpdate(userId, {
      action: 'executed',
      scheduleId,
      campaignId: schedule.campaignId,
      campaignName: schedule.campaignName,
      initiated,
      failed,
      total: numbers.length
    });

      emitAbTestResults(userId, {
      campaignId: schedule.campaignId,
      scheduleId,
      winner,
      groups: abGroupResults
      });

      emitOutboundMetrics(userId, {
      mode: 'scheduled',
      campaignId: schedule.campaignId,
      campaignName: schedule.campaignName,
      initiated,
      failed,
      total: numbers.length,
      successRate: numbers.length > 0 ? Math.round((initiated / numbers.length) * 100) : 0
    });

      return {
        initiated,
        failed,
        total: numbers.length,
        winner,
        groups: abGroupResults
      };
    } finally {
      this.executionLocks.delete(key);
    }
  }

  async runRetryQueue(userId) {
    const failedCalls = await Call.find({
      user: userId,
      direction: 'outbound-local',
      status: 'failed',
      retryAttempt: { $lt: 3 }
    }).sort({ createdAt: 1 });

    const retryPlan = exotelService.retryQueue({
      calls: failedCalls,
      maxAttempts: 3,
      retryGapHours: 2
    });

    let retried = 0;
    let stillFailed = 0;

    for (const call of retryPlan.retryable) {
      const caller = exotelService.dynamicCallerId().callerId;
      try {
        const retryResult = await exotelService.createOutboundLocalCall({
          to: call.phoneNumber,
          from: caller,
          appParams: {
            retryForCallSid: call.callSid,
            retryAttempt: Number(call.retryAttempt || 0) + 1
          }
        });

        call.status = 'initiated';
        call.retryAttempt = Number(call.retryAttempt || 0) + 1;
        call.exotelCallSid = retryResult.callSid;
        call.nextRetryAt = null;
        call.providerData = {
          ...(call.providerData || {}),
          retryFrom: call.callSid,
          from: caller,
          exotel: retryResult.raw
        };
        await call.save();
        retried += 1;
      } catch (error) {
        call.retryAttempt = Number(call.retryAttempt || 0) + 1;
        call.nextRetryAt = retryPlan.nextRetryAt;
        call.error = {
          message: error.message
        };
        await call.save();
        stillFailed += 1;
      }
    }

    await Broadcast.updateOne(
      { createdBy: userId },
      {
        $set: {
          'retryConfig.enabled': true,
          'retryConfig.maxRetries': 3,
          'retryConfig.retryGapHours': 2,
          'retryConfig.lastRetryRunAt': new Date()
        }
      }
    );

    emitRetryStats(String(userId), {
      queued: failedCalls.length,
      processed: retryPlan.retryable.length,
      retried,
      stillFailed,
      nextRetryAt: retryPlan.nextRetryAt
    });

    return {
      queued: failedCalls.length,
      processed: retryPlan.retryable.length,
      retried,
      stillFailed,
      nextRetryAt: retryPlan.nextRetryAt
    };
  }

  async triggerABTest(payload, userId) {
    const numbers = Array.from(new Set((payload?.numbers || []).map((n) => normalizeNumber(n)).filter(Boolean)));
    const templates = [
      { key: 'A', template: String(payload?.templateA || '').trim() },
      { key: 'B', template: String(payload?.templateB || '').trim() }
    ];

    if (!numbers.length) throw new Error('No valid numbers for A/B test');

    const split = exotelService.abTest({ numbers, templates });
    const groups = [];

    for (const group of split.groups) {
      let initiated = 0;
      let failed = 0;

      for (const number of group.numbers) {
        const caller = exotelService.dynamicCallerId().callerId;
        try {
          const res = await exotelService.createOutboundLocalCall({
            to: number,
            from: caller,
            appParams: {
              mode: 'abtest',
              group: group.key,
              template: group.template
            }
          });

          initiated += 1;

          await Call.create({
            callSid: res.callSid,
            exotelCallSid: res.callSid,
            user: userId,
            phoneNumber: number,
            direction: 'outbound-local',
            provider: 'exotel',
            status: 'initiated',
            startTime: new Date(),
            providerData: {
              abGroup: group.key,
              template: group.template,
              from: caller,
              exotel: res.raw
            }
          });
        } catch (error) {
          failed += 1;
        }
      }

      const total = initiated + failed;
      groups.push({
        key: group.key,
        template: group.template,
        initiated,
        failed,
        successRate: total > 0 ? Number(((initiated / total) * 100).toFixed(2)) : 0
      });
    }

    const winner = groups.sort((a, b) => b.successRate - a.successRate)[0]?.key || '';

    emitAbTestResults(String(userId), {
      campaignId: payload?.campaignId || '',
      winner,
      groups
    });

    return { winner, groups };
  }

  getRotationStats() {
    const pool = exotelService.getNumberPool();
    return {
      numbers: pool,
      poolSize: pool.length,
      currentCursor: exotelService.rotationCursor
    };
  }

  pauseSchedule(scheduleId) {
    const key = String(scheduleId);
    const task = this.tasks.get(key);
    if (task) task.stop();
  }

  resumeSchedule(scheduleDoc) {
    if (scheduleDoc && !scheduleDoc.nextRunAt) {
      scheduleDoc.nextRunAt = this.computeNextRunAt({
        recurrence: scheduleDoc.recurrence,
        timezone: scheduleDoc.timezone,
        scheduledAt: parseScheduledDateInTimezone(
          scheduleDoc.metadata?.scheduledAt || scheduleDoc.metadata?.scheduledAtLocal,
          scheduleDoc.timezone
        ),
        allowedWindowStart: scheduleDoc.metadata?.allowedWindowStart || '09:00',
        fromDate: new Date()
      });
      void scheduleDoc.save?.();
    }
    this.registerScheduleTask(scheduleDoc);
  }
}

export default new CampaignAutomationService();

