import ExecutionLog from '../models/ExecutionLog.js';
import Workflow from '../models/Workflow.js';
import logger from '../utils/logger.js';

class IVRAnalyticsService {
    /**
     * Get aggregated execution statistics for a workflow
     */
    async getWorkflowStats(workflowId, startDate, endDate) {
        try {
            return await ExecutionLog.getAnalytics(workflowId, startDate, endDate);
        } catch (error) {
            logger.error('Error getting workflow stats:', error);
            throw error;
        }
    }

    /**
     * Get recent executions for a workflow
     */
    async getRecentExecutions(workflowId, limit = 50) {
        try {
            return await ExecutionLog.find({ workflowId })
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
    async getExecutionDetails(callSid) {
        try {
            return await ExecutionLog.findOne({ callSid });
        } catch (error) {
            logger.error('Error getting execution details:', error);
            throw error;
        }
    }

    /**
     * Get node-level analytics (heatmap data)
     */
    async getNodeAnalytics(workflowId) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            const aggregation = await ExecutionLog.aggregate([
                { $match: { workflowId: workflow._id } },
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
    async getActiveCalls() {
        try {
            return await ExecutionLog.getActiveExecutions();
        } catch (error) {
            logger.error('Error getting active calls:', error);
            throw error;
        }
    }
}

export default new IVRAnalyticsService();
