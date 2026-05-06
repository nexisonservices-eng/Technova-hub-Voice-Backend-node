/**
 * Call Log Controller
 * CRUD operations for call logs with filtering, pagination, and export
 */
import Call from '../models/call.js';
import ResponseFormatter from '../utils/responseFormatter.js';
import logger from '../utils/logger.js';
import { getUserObjectId } from '../utils/authContext.js';
import analyticsController from './analyticsController.js';

const clampPositiveInt = (value, fallback, max) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, max);
};

const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const scheduleAnalyticsSnapshot = (userId, reason) => {
    analyticsController.clearUserCache(userId);
    analyticsController.scheduleAnalyticsBroadcast({ userId: String(userId), reason });
};

const buildOutboundTypeFilter = (type = 'all') => {
    const normalizedType = String(type || 'all').toLowerCase();
    if (!['single', 'bulk'].includes(normalizedType)) return null;

    if (normalizedType === 'single') {
        return {
            $or: [
                { 'providerData.originType': 'single' },
                { 'providerData.campaignType': 'single' },
                { 'providerData.singleRecipient': { $exists: true, $ne: '' } },
                { 'providerData.campaignId': { $exists: false } },
                { 'providerData.campaignId': '' }
            ]
        };
    }

    return {
        $or: [
            { 'providerData.originType': 'bulk' },
            { 'providerData.campaignType': 'bulk' },
            {
                $and: [
                    { 'providerData.campaignId': { $exists: true, $ne: '' } },
                    { 'providerData.originType': { $ne: 'single' } },
                    { 'providerData.campaignType': { $ne: 'single' } }
                ]
            }
        ]
    };
};

class CallLogController {
    /**
     * Get call logs with filtering and pagination
     * GET /api/call-logs
     */
    async getCallLogs(req, res) {
        try {
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized', 'UNAUTHORIZED'));
            }
            const {
                startDate,
                endDate,
                status,
                direction,
                type = 'all',
                phoneNumber,
                page = 1,
                limit = 20,
                sortBy = 'createdAt',
                sortOrder = 'desc'
            } = req.query;

            // Build filter query
            const filter = {
                deletedAt: null,
                user: userId,
                callSid: { $exists: true, $ne: '' },
                status: { $ne: 'scheduled' }
            }; // Exclude soft-deleted and schedule-only rows

            if (startDate || endDate) {
                filter.createdAt = {};
                if (startDate) filter.createdAt.$gte = new Date(startDate);
                if (endDate) filter.createdAt.$lte = new Date(endDate);
            }

            if (status) filter.status = status;
            if (direction) filter.direction = direction;
            if (phoneNumber) filter.phoneNumber = new RegExp(escapeRegExp(phoneNumber), 'i');
            const typeFilter = buildOutboundTypeFilter(type);
            if (typeFilter) {
                filter.$and = [...(filter.$and || []), typeFilter];
            }

            // Calculate pagination
            const pageNum = clampPositiveInt(page, 1, Number.MAX_SAFE_INTEGER);
            const limitNum = clampPositiveInt(limit, 20, 100);
            const skip = (pageNum - 1) * limitNum;

            // Execute query with pagination
            const [calls, total] = await Promise.all([
                Call.find(filter)
                    .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
                    .skip(skip)
                    .limit(limitNum)
                    .select('-__v')
                    .lean(),
                Call.countDocuments(filter)
            ]);

            logger.info(`Retrieved ${calls.length} call logs (page ${pageNum}, total: ${total})`);

            res.json(ResponseFormatter.paginated(
                calls,
                pageNum,
                limitNum,
                total
            ));

        } catch (error) {
            logger.error('Get call logs error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'GET_CALL_LOGS_ERROR')
            );
        }
    }

    /**
     * Get single call details
     * GET /api/call-logs/:callSid
     */
    async getCallDetails(req, res) {
        try {
            const { callSid } = req.params;
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized', 'UNAUTHORIZED'));
            }

            const call = await Call.findOne({ callSid, user: userId, deletedAt: null })
                .select('-__v')
                .lean();

            if (!call) {
                return res.status(404).json(
                    ResponseFormatter.notFound('Call')
                );
            }

            logger.info(`Retrieved call details: ${callSid}`);

            res.json(ResponseFormatter.success(call));

        } catch (error) {
            logger.error('Get call details error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'GET_CALL_DETAILS_ERROR')
            );
        }
    }

    /**
     * Export call logs (CSV or JSON)
     * GET /api/call-logs/export
     */
    async exportCallLogs(req, res) {
        try {
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized', 'UNAUTHORIZED'));
            }
            const {
                startDate,
                endDate,
                status,
                direction,
                phoneNumber,
                format = 'json'
            } = req.query;

            // Build filter (same as getCallLogs)
            const filter = { deletedAt: null, user: userId };

            if (startDate || endDate) {
                filter.createdAt = {};
                if (startDate) filter.createdAt.$gte = new Date(startDate);
                if (endDate) filter.createdAt.$lte = new Date(endDate);
            }

            if (status) filter.status = status;
            if (direction) filter.direction = direction;
            if (phoneNumber) filter.phoneNumber = new RegExp(phoneNumber, 'i');

            // Fetch all matching calls (limit to 10k for safety)
            const calls = await Call.find(filter)
                .sort({ createdAt: -1 })
                .limit(10000)
                .select('callSid phoneNumber direction status duration createdAt endTime routing')
                .lean();

            logger.info(`Exporting ${calls.length} call logs as ${format}`);

            if (format === 'csv') {
                // Generate CSV
                const csvHeader = 'Call SID,Phone Number,Direction,Status,Duration (s),Created At,End Time,Routing\n';
                const csvRows = calls.map(call =>
                    `${call.callSid || ''},${call.phoneNumber || ''},${call.direction || ''},${call.status || ''},${call.duration || 0},${call.createdAt?.toISOString() || ''},${call.endTime?.toISOString() || ''},${call.routing || ''}`
                ).join('\n');

                const csv = csvHeader + csvRows;

                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', `attachment; filename=call-logs-${Date.now()}.csv`);
                res.send(csv);
            } else {
                // Return JSON
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Content-Disposition', `attachment; filename=call-logs-${Date.now()}.json`);
                res.json(ResponseFormatter.success(calls));
            }

        } catch (error) {
            logger.error('Export call logs error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'EXPORT_CALL_LOGS_ERROR')
            );
        }
    }

    /**
     * Soft delete call log
     * DELETE /api/call-logs/:callSid
     */
    async deleteCallLog(req, res) {
        try {
            const { callSid } = req.params;
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized', 'UNAUTHORIZED'));
            }

            const call = await Call.findOne({ callSid, user: userId, deletedAt: null });

            if (!call) {
                return res.status(404).json(
                    ResponseFormatter.notFound('Call')
                );
            }

            // Soft delete
            call.deletedAt = new Date();
            await call.save();
            scheduleAnalyticsSnapshot(userId, 'call_log_deleted');

            logger.info(`Soft deleted call log: ${callSid}`);

            res.json(ResponseFormatter.success({
                callSid,
                deletedAt: call.deletedAt
            }));

        } catch (error) {
            logger.error('Delete call log error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'DELETE_CALL_LOG_ERROR')
            );
        }
    }

    /**
     * Bulk delete call logs
     * POST /api/call-logs/bulk-delete
     */
    async bulkDeleteCallLogs(req, res) {
        try {
            const { callSids } = req.body;
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized', 'UNAUTHORIZED'));
            }

            if (!Array.isArray(callSids) || callSids.length === 0) {
                return res.status(400).json(
                    ResponseFormatter.validationError([{
                        field: 'callSids',
                        message: 'callSids must be a non-empty array'
                    }])
                );
            }

            // Bulk soft delete
            const resultScoped = await Call.updateMany(
                { callSid: { $in: callSids }, user: userId, deletedAt: null },
                { $set: { deletedAt: new Date() } }
            );

            logger.info(`Bulk deleted ${resultScoped.modifiedCount} call logs`);
            if (resultScoped.modifiedCount > 0) {
                scheduleAnalyticsSnapshot(userId, 'call_logs_bulk_deleted');
            }

            res.json(ResponseFormatter.success({
                deletedCount: resultScoped.modifiedCount,
                requestedCount: callSids.length
            }));

        } catch (error) {
            logger.error('Bulk delete call logs error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'BULK_DELETE_CALL_LOGS_ERROR')
            );
        }
    }

    /**
     * Add tags to call log
     * POST /api/call-logs/:callSid/tags
     */
    async addTags(req, res) {
        try {
            const { callSid } = req.params;
            const { tags } = req.body;
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized', 'UNAUTHORIZED'));
            }

            if (!Array.isArray(tags) || tags.length === 0) {
                return res.status(400).json(
                    ResponseFormatter.validationError([{
                        field: 'tags',
                        message: 'tags must be a non-empty array'
                    }])
                );
            }

            const call = await Call.findOne({ callSid, user: userId, deletedAt: null });

            if (!call) {
                return res.status(404).json(
                    ResponseFormatter.notFound('Call')
                );
            }

            // Add tags (avoid duplicates)
            call.tags = [...new Set([...(call.tags || []), ...tags])];
            await call.save();
            scheduleAnalyticsSnapshot(userId, 'call_log_tags_updated');

            logger.info(`Added tags to call ${callSid}: ${tags.join(', ')}`);

            res.json(ResponseFormatter.success({
                callSid,
                tags: call.tags
            }));

        } catch (error) {
            logger.error('Add tags error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'ADD_TAGS_ERROR')
            );
        }
    }

    /**
     * Get call statistics
     * GET /api/call-logs/stats
     */
    async getCallStats(req, res) {
        try {
            const { startDate, endDate } = req.query;
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized', 'UNAUTHORIZED'));
            }

            const filter = { deletedAt: null, user: userId };

            if (startDate || endDate) {
                filter.createdAt = {};
                if (startDate) filter.createdAt.$gte = new Date(startDate);
                if (endDate) filter.createdAt.$lte = new Date(endDate);
            }

            const stats = await Call.aggregate([
                { $match: filter },
                {
                    $group: {
                        _id: null,
                        totalCalls: { $sum: 1 },
                        completedCalls: {
                            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
                        },
                        failedCalls: {
                            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
                        },
                        totalDuration: { $sum: '$duration' },
                        avgDuration: { $avg: '$duration' },
                        inboundCalls: {
                            $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] }
                        },
                        outboundCalls: {
                            $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] }
                        }
                    }
                }
            ]);

            const result = stats[0] || {
                totalCalls: 0,
                completedCalls: 0,
                failedCalls: 0,
                totalDuration: 0,
                avgDuration: 0,
                inboundCalls: 0,
                outboundCalls: 0
            };

            // Calculate success rate
            result.successRate = result.totalCalls > 0
                ? Math.round((result.completedCalls / result.totalCalls) * 100)
                : 0;

            logger.info('Retrieved call statistics');

            res.json(ResponseFormatter.success(result));

        } catch (error) {
            logger.error('Get call stats error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'GET_CALL_STATS_ERROR')
            );
        }
    }
}

export default new CallLogController();
