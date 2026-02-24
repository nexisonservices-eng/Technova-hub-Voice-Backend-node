import ExecutionLog from '../models/ExecutionLog.js';
import Workflow from '../models/Workflow.js';
import logger from '../utils/logger.js';

class IVRAnalyticsService {
    /**
     * Get aggregated execution statistics for a workflow
     */
    async getWorkflowStats(workflowId, startDate, endDate, userId = null) {
        try {
            const query = { workflowId, ...(userId ? { userId } : {}) };
            if (startDate || endDate) {
                query.startTime = {};
                if (startDate) query.startTime.$gte = new Date(startDate);
                if (endDate) query.startTime.$lte = new Date(endDate);
            }

            const executions = await ExecutionLog.find(query).lean();
            const total = executions.length;
            const completed = executions.filter((e) => e.status === 'completed').length;
            const failed = executions.filter((e) => e.status === 'failed').length;
            const timeout = executions.filter((e) => e.status === 'timeout').length;
            const totalDuration = executions.reduce((sum, e) => sum + (e.duration || 0), 0);
            return {
                totalExecutions: total,
                completedExecutions: completed,
                failedExecutions: failed,
                timeoutExecutions: timeout,
                averageDuration: total > 0 ? totalDuration / total : 0
            };
        } catch (error) {
            logger.error('Error getting workflow stats:', error);
            throw error;
        }
    }

    /**
     * Get recent executions for a workflow
     */
    async getRecentExecutions(workflowId, limit = 50, userId = null) {
        try {
            return await ExecutionLog.find({ workflowId, ...(userId ? { userId } : {}) })
                .sort({ createdAt: -1 })
                .limit(limit)
                .select('-__v');
        } catch (error) {
            logger.error('Error getting recent executions:', error);
            throw error;
        }
    }

    /**
     * Get detailed execution log by CallSid
     */
    async getExecutionDetails(callSid, userId = null) {
        try {
            return await ExecutionLog.findOne({ callSid, ...(userId ? { userId } : {}) });
        } catch (error) {
            logger.error('Error getting execution details:', error);
            throw error;
        }
    }

    /**
     * Get node-level analytics (heatmap data)
     */
    async getNodeAnalytics(workflowId, userId = null) {
        try {
            const workflow = await Workflow.findOne({ _id: workflowId, ...(userId ? { createdBy: userId } : {}) });
            if (!workflow) throw new Error('Workflow not found');

            const aggregation = await ExecutionLog.aggregate([
                { $match: { workflowId: workflow._id, ...(userId ? { userId } : {}) } },
                { $unwind: '$visitedNodes' },
                {
                    $group: {
                        _id: '$visitedNodes.nodeId',
                        count: { $sum: 1 },
                        avgDuration: { $avg: '$visitedNodes.duration' },
                        uniqueCallers: { $addToSet: '$callSid' }
                    }
                },
                {
                    $project: {
                        nodeId: '$_id',
                        count: 1,
                        avgDuration: 1,
                        uniqueCallers: { $size: '$uniqueCallers' }
                    }
                }
            ]);

            // Map back to node IDs for frontend consumption
            const nodeStats = {};
            aggregation.forEach(stat => {
                nodeStats[stat.nodeId] = {
                    visits: stat.count,
                    uniqueUsers: stat.uniqueCallers,
                    avgDropoff: 0 // Placeholder for dropoff calculation
                };
            });

            return nodeStats;
        } catch (error) {
            logger.error('Error getting node analytics:', error);
            throw error;
        }
    }

    /**
     * Get Real-time active calls
     */
    async getActiveCalls(userId = null) {
        try {
            return await ExecutionLog.find({ status: 'running', ...(userId ? { userId } : {}) });
        } catch (error) {
            logger.error('Error getting active calls:', error);
            throw error;
        }
    }
}

export default new IVRAnalyticsService();
