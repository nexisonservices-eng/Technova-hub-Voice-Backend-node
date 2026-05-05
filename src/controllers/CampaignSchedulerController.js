import campaignAutomationService from '../services/campaignAutomationService.js';
import CampaignSchedule from '../models/CampaignSchedule.js';
import { getUserIdString, getUserObjectId } from '../utils/authContext.js';
import { emitCampaignUpdate } from '../sockets/unifiedSocket.js';
import logger from '../utils/logger.js';

const deriveScheduleType = (schedule = {}) => {
  const metadata = schedule.metadata || {};
  const explicitType = String(
    schedule.type ||
    schedule.campaignType ||
    schedule.originType ||
    metadata.type ||
    metadata.campaignType ||
    metadata.originType ||
    ''
  ).trim().toLowerCase();

  if (explicitType === 'single' || explicitType === 'bulk') return explicitType;

  const numbers = Array.isArray(schedule.numbers) ? schedule.numbers : [];
  const contactCount = Number(schedule.contactCount ?? metadata.contactCount ?? numbers.length ?? 0) || 0;
  const campaignName = String(schedule.campaignName || metadata.campaignName || '').trim();
  if ((metadata.singleRecipient || numbers.length === 1) && contactCount <= 1) return 'single';
  if (contactCount === 1 && /^single call\b/i.test(campaignName)) return 'single';
  return 'bulk';
};

const buildScheduleTypeFilter = (type = 'all') => {
  const normalizedType = String(type || 'all').toLowerCase();
  const singleConditions = [
    { 'metadata.originType': 'single' },
    { 'metadata.campaignType': 'single' },
    { 'metadata.singleRecipient': { $exists: true, $ne: '' } },
    { $and: [{ campaignName: /^single call\b/i }, { numbers: { $size: 1 } }] }
  ];

  if (normalizedType === 'single') return { $or: singleConditions };
  if (normalizedType === 'bulk') return { $nor: singleConditions };
  return null;
};

const normalizeSchedule = (schedule = {}) => {
  const metadata = schedule.metadata || {};
  const numbers = Array.isArray(schedule.numbers) ? schedule.numbers : [];
  const type = deriveScheduleType(schedule);
  const contactCount = Number(schedule.contactCount ?? metadata.contactCount ?? numbers.length ?? 0) || 0;

  return {
    ...schedule,
    id: schedule._id,
    type,
    provider: schedule.provider || metadata.provider || 'twilio',
    singleRecipient: schedule.singleRecipient || metadata.singleRecipient || numbers[0] || '',
    contactCount,
    workflowId: schedule.workflowId || metadata.workflowId || '',
    scheduledAt: schedule.scheduledAt || metadata.scheduledAt || schedule.createdAt || null,
    nextRunAt: schedule.nextRunAt || null,
    allowedWindow: schedule.allowedWindow || metadata.allowedWindow || {
      start: metadata.allowedWindowStart || metadata.windowStart || null,
      end: metadata.allowedWindowEnd || metadata.windowEnd || null
    }
  };
};

class CampaignSchedulerController {
  async listSchedules(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const {
        status = 'all',
        recurrence = 'all',
        type = 'all',
        search = '',
        page = 1,
        limit = 10
      } = req.query;

      const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10));
      const skip = (pageNum - 1) * limitNum;

      const filter = { userId: userObjectId };
      if (status && status !== 'all') {
        filter.status = status;
      }
      if (recurrence && recurrence !== 'all') {
        filter.recurrence = recurrence;
      }
      const typeFilter = buildScheduleTypeFilter(type);
      if (typeFilter) {
        filter.$and = [...(filter.$and || []), typeFilter];
      }
      if (search && String(search).trim()) {
        const value = String(search).trim();
        filter.$and = [
          ...(filter.$and || []),
          {
            $or: [
              { campaignName: { $regex: value, $options: 'i' } },
              { campaignId: { $regex: value, $options: 'i' } },
              { numbers: { $elemMatch: { $regex: value, $options: 'i' } } },
              { 'metadata.singleRecipient': { $regex: value, $options: 'i' } }
            ]
          }
        ];
      }

      const [items, total] = await Promise.all([
        CampaignSchedule.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        CampaignSchedule.countDocuments(filter)
      ]);

      return res.status(200).json({
        success: true,
        data: items.map(normalizeSchedule),
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum)
        }
      });
    } catch (error) {
      logger.error('List schedules failed:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async schedule(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const schedule = await campaignAutomationService.createSchedule(req.body || {}, userObjectId);
      const normalizedSchedule = normalizeSchedule(typeof schedule?.toObject === 'function' ? schedule.toObject() : schedule);
      emitCampaignUpdate(getUserIdString(req), {
        action: 'schedule_created',
        schedule: normalizedSchedule
      });

      return res.status(201).json({
        success: true,
        schedule: normalizedSchedule
      });
    } catch (error) {
      logger.error('Campaign schedule failed:', error);
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async retry(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const result = await campaignAutomationService.runRetryQueue(userObjectId);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      logger.error('Retry queue failed:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async abtest(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const result = await campaignAutomationService.triggerABTest(req.body || {}, userObjectId);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      logger.error('AB test creation failed:', error);
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async rotateNumbers(req, res) {
    try {
      const userId = getUserIdString(req);
      if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const stats = campaignAutomationService.getRotationStats();
      return res.status(200).json({ success: true, ...stats });
    } catch (error) {
      logger.error('Number rotation stats failed:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async pause(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      const { scheduleId } = req.params;
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const schedule = await CampaignSchedule.findOneAndUpdate(
        { _id: scheduleId, userId: userObjectId },
        { $set: { status: 'paused', pausedAt: new Date() } },
        { new: true }
      );

      if (!schedule) {
        return res.status(404).json({ success: false, message: 'Schedule not found' });
      }

      campaignAutomationService.pauseSchedule(scheduleId);
      const normalizedSchedule = normalizeSchedule(schedule.toObject ? schedule.toObject() : schedule);
      emitCampaignUpdate(getUserIdString(req), {
        action: 'schedule_paused',
        schedule: normalizedSchedule
      });
      return res.status(200).json({ success: true, status: schedule.status, schedule: normalizedSchedule });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async resume(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      const { scheduleId } = req.params;
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const schedule = await CampaignSchedule.findOneAndUpdate(
        { _id: scheduleId, userId: userObjectId },
        { $set: { status: 'active' }, $unset: { pausedAt: '' } },
        { new: true }
      );

      if (!schedule) {
        return res.status(404).json({ success: false, message: 'Schedule not found' });
      }

      campaignAutomationService.resumeSchedule(schedule);
      const normalizedSchedule = normalizeSchedule(schedule.toObject ? schedule.toObject() : schedule);
      emitCampaignUpdate(getUserIdString(req), {
        action: 'schedule_resumed',
        schedule: normalizedSchedule
      });
      return res.status(200).json({ success: true, status: schedule.status, schedule: normalizedSchedule });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async bulkDelete(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const scheduleIds = Array.isArray(req.body?.scheduleIds)
        ? req.body.scheduleIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
      if (!scheduleIds.length) {
        return res.status(400).json({ success: false, message: 'scheduleIds must be a non-empty array' });
      }

      const schedules = await CampaignSchedule.find({
        _id: { $in: scheduleIds },
        userId: userObjectId
      }).select('_id').lean();

      const ownedIds = schedules.map((schedule) => String(schedule._id));
      if (!ownedIds.length) {
        return res.status(404).json({ success: false, message: 'No schedules found to delete' });
      }

      const result = await CampaignSchedule.deleteMany({
        _id: { $in: ownedIds },
        userId: userObjectId
      });
      ownedIds.forEach((scheduleId) => campaignAutomationService.removeSchedule(scheduleId));
      emitCampaignUpdate(getUserIdString(req), {
        action: 'schedule_deleted',
        scheduleIds: ownedIds
      });

      return res.status(200).json({
        success: true,
        deletedCount: result.deletedCount || 0,
        scheduleIds: ownedIds
      });
    } catch (error) {
      logger.error('Bulk delete schedules failed:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

export default new CampaignSchedulerController();
