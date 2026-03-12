import campaignAutomationService from '../services/campaignAutomationService.js';
import CampaignSchedule from '../models/CampaignSchedule.js';
import { getUserIdString, getUserObjectId } from '../utils/authContext.js';
import logger from '../utils/logger.js';

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
      if (search && String(search).trim()) {
        const value = String(search).trim();
        filter.$or = [
          { campaignName: { $regex: value, $options: 'i' } },
          { campaignId: { $regex: value, $options: 'i' } }
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
        data: items,
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

      return res.status(201).json({
        success: true,
        schedule: {
          id: schedule._id,
          campaignId: schedule.campaignId,
          campaignName: schedule.campaignName,
          cronExpression: schedule.cronExpression,
          recurrence: schedule.recurrence,
          status: schedule.status
        }
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
      return res.status(200).json({ success: true, status: schedule.status });
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
      return res.status(200).json({ success: true, status: schedule.status });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

export default new CampaignSchedulerController();
