import broadcastService from '../services/broadcastService.js';
import Broadcast from '../models/Broadcast.js';
import BroadcastCall from '../models/BroadcastCall.js';
import mongoose from 'mongoose';
import { validateTemplate } from '../utils/messagePersonalizer.js';
import logger from '../utils/logger.js';
import { getUserObjectId } from '../utils/authContext.js';
import { reportUsage } from '../services/usageService.js';

/**
 * Helper function to extract user ID from request
 */
class BroadcastController {
  constructor() {
    this.getBroadcastCalls = this.getBroadcastCalls.bind(this);
    this.listBroadcasts = this.listBroadcasts.bind(this);
    this.getBroadcastSummaryDetails = this.getBroadcastSummaryDetails.bind(this);
    this.bulkCancelBroadcasts = this.bulkCancelBroadcasts.bind(this);
    this.bulkDeleteBroadcasts = this.bulkDeleteBroadcasts.bind(this);
  }

  escapeRegex(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  normalizeListStatus(status) {
    const normalized = String(status || '').toLowerCase().trim();
    const statusMap = {
      active: ['in_progress', 'queued'],
      completed: ['completed'],
      failed: ['cancelled'],
      pending: ['draft', 'queued'],
      draft: ['draft'],
      queued: ['queued'],
      in_progress: ['in_progress'],
      cancelled: ['cancelled']
    };

    return statusMap[normalized] || null;
  }

  normalizeListSort(sort) {
    const normalized = String(sort || 'newest').toLowerCase().trim();
    const sortMap = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      status: { status: 1, createdAt: -1 },
      name: { name: 1, createdAt: -1 },
      success: { successRate: -1, createdAt: -1 },
      'success%': { successRate: -1, createdAt: -1 },
      progress: { progressRate: -1, createdAt: -1 }
    };

    return sortMap[normalized] || sortMap.newest;
  }

  encodeCallsCursor(call, sortField) {
    if (!call) return null;
    const rawValue = call[sortField];
    const value = rawValue instanceof Date ? rawValue.toISOString() : rawValue;
    return Buffer.from(JSON.stringify({
      value: value ?? null,
      id: String(call._id)
    })).toString('base64');
  }

  decodeCallsCursor(cursor, sortField) {
    if (!cursor) return null;
    try {
      const parsed = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
      if (!parsed?.id || !mongoose.Types.ObjectId.isValid(parsed.id)) return null;

      const dateFields = new Set(['createdAt', 'updatedAt', 'startTime']);
      const numericFields = new Set(['attempts']);
      let value = parsed.value;

      if (dateFields.has(sortField) && value) {
        value = new Date(value);
        if (Number.isNaN(value.getTime())) return null;
      } else if (numericFields.has(sortField)) {
        value = Number(value);
        if (!Number.isFinite(value)) return null;
      }

      return {
        value,
        id: new mongoose.Types.ObjectId(parsed.id)
      };
    } catch {
      return null;
    }
  }

  buildCallsCursorQuery(cursor, sortField, sortDirection) {
    if (!cursor || cursor.value === null || cursor.value === undefined) return {};
    const operator = sortDirection === 1 ? '$gt' : '$lt';

    return {
      $or: [
        { [sortField]: { [operator]: cursor.value } },
        {
          [sortField]: cursor.value,
          _id: { [operator]: cursor.id }
        }
      ]
    };
  }

  getProgressExpression() {
    return {
      $cond: [
        { $gt: ['$stats.total', 0] },
        {
          $multiply: [
            {
              $divide: [
                { $add: ['$stats.completed', '$stats.failed', '$stats.opted_out'] },
                '$stats.total'
              ]
            },
            100
          ]
        },
        0
      ]
    };
  }

  getSuccessExpression() {
    return {
      $cond: [
        { $gt: [{ $add: ['$stats.completed', '$stats.failed'] }, 0] },
        {
          $multiply: [
            {
              $divide: [
                '$stats.completed',
                { $add: ['$stats.completed', '$stats.failed'] }
              ]
            },
            100
          ]
        },
        0
      ]
    };
  }

  /**
   * POST /broadcast/start
   * Create and start broadcast campaign
   */
  async startBroadcast(req, res) {
    try {
      const {
        name,
        messageTemplate,
        voice,
        contacts,
        maxConcurrent,
        batchSize,
        dispatchIntervalMs,
        maxRetries,
        retryDelay,
        compliance
      } = req.body;
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: invalid user identity' });
      }

      // Validate template
      const templateValidation = validateTemplate(messageTemplate);
      if (!templateValidation.valid) {
        return res.status(400).json({
          error: 'Invalid message template',
          details: templateValidation.errors
        });
      }

      // Validate contacts
      if (!contacts || contacts.length === 0) {
        return res.status(400).json({
          error: 'No contacts provided'
        });
      }

      if (contacts.length > 10000) {
        return res.status(400).json({
          error: 'Maximum 10,000 contacts per broadcast'
        });
      }

      // Create broadcast
      const broadcast = await broadcastService.createBroadcast(
        {
          name,
          messageTemplate,
          voice,
          contacts,
          maxConcurrent,
          batchSize,
          dispatchIntervalMs,
          maxRetries,
          retryDelay,
          compliance
        },
        userId
      );

      reportUsage({
        companyId: req.user?.companyId,
        userId,
        usageType: 'voice_call',
        count: Array.isArray(contacts) ? contacts.length : 1
      });

      // Start broadcast asynchronously
      broadcastService.startBroadcast(broadcast._id, userId, req.user || {}).catch(error => {
        logger.error(
          `Failed to start broadcast ${broadcast._id}:`,
          error
        );
      });

      res.status(201).json({
        success: true,
        broadcast: {
          id: broadcast._id,
          name: broadcast.name,
          status: broadcast.status,
          totalContacts: broadcast.contacts.length
        }
      });
    } catch (error) {
      logger.error('Start broadcast error:', error);
      res.status(500).json({
        error: 'Failed to start broadcast',
        message: error.message
      });
    }
  }

  /**
   * GET /broadcast/status/:id
   * Get real-time broadcast status
   */
  async getBroadcastStatus(req, res) {
    try {
      const { id } = req.params;
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: invalid user identity' });
      }
      const broadcast = await broadcastService.getBroadcastStatus(id, userId);

      res.json({
        success: true,
        broadcast: {
          id: broadcast._id,
          name: broadcast.name,
          status: broadcast.status,
          stats: broadcast.stats,
          startedAt: broadcast.startedAt,
          completedAt: broadcast.completedAt,
          config: broadcast.config
        }
      });
    } catch (error) {
      logger.error('Get broadcast status error:', error);
      res.status(500).json({
        error: 'Failed to get broadcast status',
        message: error.message
      });
    }
  }

  /**
   * POST /broadcast/:id/cancel
   * Cancel ongoing broadcast
   */
  async cancelBroadcast(req, res) {
    try {
      const { id } = req.params;
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: invalid user identity' });
      }
      const broadcast = await broadcastService.cancelBroadcast(id, userId);

      res.json({
        success: true,
        message: 'Broadcast cancelled',
        broadcast: {
          id: broadcast._id,
          status: broadcast.status,
          stats: broadcast.stats
        }
      });
    } catch (error) {
      logger.error('Cancel broadcast error:', error);
      res.status(500).json({
        error: 'Failed to cancel broadcast',
        message: error.message
      });
    }
  }

  /**
   * GET /broadcast/:id/calls
   * Get individual call details
   */
  async getBroadcastCalls(req, res) {
    try {
      const { id } = req.params;
      const { status, page = 1, limit = 50, sort = 'createdAt:desc', cursor } = req.query;
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: invalid user identity' });
      }
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid broadcast id' });
      }

      const query = { broadcast: new mongoose.Types.ObjectId(id), userId };
      if (status) {
        query.status = status;
      }

      const parsedLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const parsedPage = Math.max(1, parseInt(page, 10) || 1);
      const [sortField = 'createdAt', sortDirection = 'desc'] = String(sort).split(':');
      const allowedSortFields = new Set(['createdAt', 'updatedAt', 'startTime', 'status', 'attempts']);
      const safeSortField = allowedSortFields.has(sortField) ? sortField : 'createdAt';
      const safeSortDirection = sortDirection === 'asc' ? 1 : -1;
      const decodedCursor = this.decodeCallsCursor(cursor, safeSortField);
      const cursorQuery = this.buildCallsCursorQuery(decodedCursor, safeSortField, safeSortDirection);
      const finalQuery = decodedCursor ? { ...query, ...cursorQuery } : query;
      const hasCursor = Boolean(decodedCursor);
      const findLimit = hasCursor ? parsedLimit + 1 : parsedLimit;
      const skip = hasCursor ? 0 : (parsedPage - 1) * parsedLimit;
      const projection = 'contact.phone contact.name status attempts duration startTime answerTime endTime createdAt updatedAt twilioError callSid optedOut';

      const [rawCalls, total] = await Promise.all([
        BroadcastCall.find(finalQuery)
          .select(projection)
          .sort({ [safeSortField]: safeSortDirection, _id: safeSortDirection })
          .limit(findLimit)
          .skip(skip)
          .lean(),
        BroadcastCall.countDocuments(query)
      ]);

      const hasMore = hasCursor && rawCalls.length > parsedLimit;
      const calls = hasMore ? rawCalls.slice(0, parsedLimit) : rawCalls;
      const lastCall = calls[calls.length - 1] || null;

      res.json({
        success: true,
        calls,
        pagination: {
          page: parsedPage,
          limit: parsedLimit,
          total,
          pages: Math.ceil(total / parsedLimit),
          ...(hasCursor ? {
            cursor,
            nextCursor: hasMore ? this.encodeCallsCursor(lastCall, safeSortField) : null,
            hasMore
          } : {})
        }
      });
    } catch (error) {
      logger.error('Get broadcast calls error:', error);
      res.status(500).json({
        error: 'Failed to get broadcast calls',
        message: error.message
      });
    }
  }

  /**
   * GET /broadcast/list
   * List all broadcasts
   */
  async listBroadcasts(req, res) {
    try {
      const { status, page = 1, limit = 25, search = '', sort = 'newest' } = req.query;
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: invalid user identity' });
      }

      const query = { createdBy: userId };
      const statusFilter = this.normalizeListStatus(status);
      if (statusFilter) {
        query.status = { $in: statusFilter };
      }

      const trimmedSearch = String(search || '').trim();
      if (trimmedSearch) {
        query.name = { $regex: this.escapeRegex(trimmedSearch), $options: 'i' };
      }

      const allowedLimits = new Set([25, 50, 100]);
      const requestedLimit = parseInt(limit, 10) || 25;
      const parsedLimit = allowedLimits.has(requestedLimit) ? requestedLimit : 25;
      const parsedPage = Math.max(1, parseInt(page, 10) || 1);
      const skip = (parsedPage - 1) * parsedLimit;
      const addFields = {
        progressRate: this.getProgressExpression(),
        successRate: this.getSuccessExpression()
      };

      const [listResult, summaryResult] = await Promise.all([
        Broadcast.aggregate([
          { $match: query },
          { $addFields: addFields },
          { $sort: this.normalizeListSort(sort) },
          { $skip: skip },
          { $limit: parsedLimit },
          {
            $project: {
              contacts: 0,
              audioAssets: 0,
              messageTemplate: 0
            }
          }
        ]),
        Broadcast.aggregate([
          {
            $match: {
              createdBy: userId,
              ...(trimmedSearch ? { name: { $regex: this.escapeRegex(trimmedSearch), $options: 'i' } } : {})
            }
          },
          { $addFields: addFields },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: {
                $sum: { $cond: [{ $in: ['$status', ['queued', 'in_progress']] }, 1, 0] }
              },
              completed: {
                $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
              },
              failed: {
                $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] }
              },
              runningNow: {
                $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] }
              },
              avgSuccessRate: { $avg: '$successRate' }
            }
          }
        ])
      ]);

      const total = await Broadcast.countDocuments(query);
      const summary = summaryResult[0] || {
        total: 0,
        active: 0,
        completed: 0,
        failed: 0,
        runningNow: 0,
        avgSuccessRate: 0
      };

      res.json({
        success: true,
        campaigns: listResult,
        broadcasts: listResult,
        total,
        summary: {
          active: summary.active || 0,
          completed: summary.completed || 0,
          failed: summary.failed || 0,
          avgSuccessRate: Math.round(summary.avgSuccessRate || 0),
          runningNow: summary.runningNow || 0
        },
        pagination: {
          page: parsedPage,
          limit: parsedLimit,
          total,
          pages: Math.ceil(total / parsedLimit)
        }
      });
    } catch (error) {
      logger.error('List broadcasts error:', error);
      res.status(500).json({
        error: 'Failed to list broadcasts',
        message: error.message
      });
    }
  }

  async getBroadcastSummaryDetails(req, res) {
    try {
      const { id } = req.params;
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: invalid user identity' });
      }
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid broadcast id' });
      }

      const broadcast = await Broadcast.findOne({ _id: id, createdBy: userId }).select('_id').lean();
      if (!broadcast) {
        return res.status(404).json({ error: 'Broadcast not found' });
      }

      const [lastCalls, failureReasons, retryAgg] = await Promise.all([
        BroadcastCall.find({ broadcast: id, userId })
          .sort({ updatedAt: -1, createdAt: -1 })
          .limit(5)
          .select('contact.phone status updatedAt createdAt attempts twilioError')
          .lean(),
        BroadcastCall.aggregate([
          {
            $match: {
              broadcast: new mongoose.Types.ObjectId(id),
              userId,
              status: { $in: ['failed', 'busy', 'no_answer', 'cancelled'] }
            }
          },
          {
            $group: {
              _id: {
                $ifNull: ['$twilioError.message', '$status']
              },
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } },
          { $limit: 5 }
        ]),
        BroadcastCall.aggregate([
          {
            $match: {
              broadcast: new mongoose.Types.ObjectId(id),
              userId
            }
          },
          {
            $group: {
              _id: null,
              totalAttempts: { $sum: '$attempts' },
              retriedCalls: {
                $sum: { $cond: [{ $gt: ['$attempts', 1] }, 1, 0] }
              },
              maxAttempts: { $max: '$attempts' }
            }
          }
        ])
      ]);

      res.json({
        success: true,
        details: {
          lastCalls: lastCalls.map((call) => ({
            id: call._id,
            phone: call.contact?.phone || '',
            status: call.status,
            time: call.updatedAt || call.createdAt,
            attempts: call.attempts || 0
          })),
          failureReasons: failureReasons.map((reason) => ({
            reason: reason._id || 'Unknown',
            count: reason.count
          })),
          retrySummary: retryAgg[0] || {
            totalAttempts: 0,
            retriedCalls: 0,
            maxAttempts: 0
          }
        }
      });
    } catch (error) {
      logger.error('Get broadcast summary details error:', error);
      res.status(500).json({
        error: 'Failed to get broadcast summary details',
        message: error.message
      });
    }
  }

  async bulkCancelBroadcasts(req, res) {
    try {
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: invalid user identity' });
      }

      const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : [];
      const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
      const activeBroadcasts = await Broadcast.find({
        _id: { $in: validIds },
        createdBy: userId,
        status: { $in: ['queued', 'in_progress'] }
      }).select('_id').lean();
      const results = await Promise.allSettled(
        activeBroadcasts.map((broadcast) => broadcastService.cancelBroadcast(broadcast._id, userId))
      );

      res.json({
        success: true,
        requested: ids.length,
        processed: activeBroadcasts.length,
        cancelled: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length
      });
    } catch (error) {
      logger.error('Bulk cancel broadcasts error:', error);
      res.status(500).json({
        error: 'Failed to bulk cancel broadcasts',
        message: error.message
      });
    }
  }

  async bulkDeleteBroadcasts(req, res) {
    try {
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: invalid user identity' });
      }

      const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : [];
      const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
      const results = await Promise.allSettled(
        validIds.map((id) => broadcastService.deleteBroadcast(id, userId, req.user || {}))
      );

      res.json({
        success: true,
        requested: ids.length,
        processed: validIds.length,
        deleted: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length
      });
    } catch (error) {
      logger.error('Bulk delete broadcasts error:', error);
      res.status(500).json({
        error: 'Failed to bulk delete broadcasts',
        message: error.message
      });
    }
  }

  /**
   * DELETE /broadcast/:id
   * Delete broadcast and history
   */
  async deleteBroadcast(req, res) {
    try {
      const { id } = req.params;
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: invalid user identity' });
      }
      await broadcastService.deleteBroadcast(id, userId, req.user || {});

      res.json({
        success: true,
        message: 'Broadcast deleted successfully'
      });
    } catch (error) {
      logger.error('Delete broadcast error:', error);
      res.status(500).json({
        error: 'Failed to delete broadcast',
        message: error.message
      });
    }
  }
}

export default new BroadcastController();
