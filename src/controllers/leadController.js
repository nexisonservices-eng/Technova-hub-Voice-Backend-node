import leadService from '../services/leadService.js';
import WorkflowExecution from '../models/WorkflowExecution.js';
import ResponseFormatter from '../utils/responseFormatter.js';
import logger from '../utils/logger.js';
import { getUserObjectId } from '../utils/authContext.js';

class LeadController {
    /**
     * Get all leads (with filters)
     */
    async getLeads(req, res) {
        try {
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized'));
            }
            const { page, limit, status, intent, search, workflowId } = req.query;
            const filters = {};

            filters.user = userId;

            if (status) filters.status = status;
            if (intent) filters.intent = intent;

            if (search) {
                filters.$or = [
                    { 'caller.phoneNumber': { $regex: search, $options: 'i' } },
                    { 'caller.name': { $regex: search, $options: 'i' } },
                    { 'bookingDetails.notes': { $regex: search, $options: 'i' } }
                ];
            }

            if (workflowId) {
                const executionFilter = { workflowId, userId };
                const executions = await WorkflowExecution.find(executionFilter)
                    .select('callSid')
                    .lean();
                const workflowCallSids = [...new Set(executions.map((item) => item.callSid).filter(Boolean))];

                if (workflowCallSids.length === 0) {
                    return res.json(ResponseFormatter.success({
                        leads: [],
                        pagination: {
                            total: 0,
                            page: Number(page) || 1,
                            pages: 0,
                            hasMore: false
                        }
                    }, 'Leads retrieved successfully'));
                }

                filters.callSid = { $in: workflowCallSids };
            }

            const result = await leadService.getLeads(filters, { page, limit });
            res.json(ResponseFormatter.success(result, 'Leads retrieved successfully'));
        } catch (error) {
            logger.error('Get leads error:', error);
            res.status(500).json(ResponseFormatter.error(error.message));
        }
    }

    /**
     * Get single lead details
     */
    async getLeadById(req, res) {
        try {
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized'));
            }
            const lead = await leadService.getLeadById(req.params.id, userId);

            // Permission check
            if (lead.user && String(lead.user._id) !== String(userId)) {
                return res.status(403).json(ResponseFormatter.error('Unauthorized access to lead'));
            }

            res.json(ResponseFormatter.success(lead));
        } catch (error) {
            res.status(404).json(ResponseFormatter.error(error.message));
        }
    }

    /**
     * Update lead
     */
    async updateLead(req, res) {
        try {
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized'));
            }
            const lead = await leadService.updateLead(req.params.id, req.body, userId);
            res.json(ResponseFormatter.success(lead, 'Lead updated successfully'));
        } catch (error) {
            res.status(500).json(ResponseFormatter.error(error.message));
        }
    }

    /**
     * Delete lead
     */
    async deleteLead(req, res) {
        try {
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized'));
            }
            // Use service method (if exists, or direct db call via service)
            // For now using update to set cancelled or strict delete if implemented
            await leadService.updateLead(req.params.id, { status: 'CANCELLED' }, userId);
            // OR actually delete: await Lead.findByIdAndDelete(req.params.id);

            res.json(ResponseFormatter.success(null, 'Lead deleted successfully'));
        } catch (error) {
            res.status(500).json(ResponseFormatter.error(error.message));
        }
    }

    /**
     * Export leads to CSV
     */
    async exportLeads(req, res) {
        try {
            const userId = getUserObjectId(req);
            if (!userId) {
                return res.status(401).json(ResponseFormatter.error('Unauthorized'));
            }
            const { status, intent } = req.query;
            const filters = {};
            filters.user = userId;
            if (status) filters.status = status;
            if (intent) filters.intent = intent;

            const { leads } = await leadService.getLeads(filters, { limit: 1000 }); // Cap at 1000 for now

            // Convert to CSV
            const fields = ['_id', 'caller.name', 'caller.phoneNumber', 'intent', 'status', 'createdAt'];
            const csv = leads.map(lead => {
                return `${lead._id},"${lead.caller?.name || ''}","${lead.caller?.phoneNumber}",${lead.intent},${lead.status},${lead.createdAt}`;
            }).join('\n');

            const header = 'Lead ID,Name,Phone,Intent,Status,Created At\n';

            res.header('Content-Type', 'text/csv');
            res.attachment('leads_export.csv');
            return res.send(header + csv);

        } catch (error) {
            logger.error('Export leads error:', error);
            res.status(500).json(ResponseFormatter.error(error.message));
        }
    }
}

export default new LeadController();
