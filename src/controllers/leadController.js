import leadService from '../services/leadService.js';
import ResponseFormatter from '../utils/responseFormatter.js';
import logger from '../utils/logger.js';

class LeadController {
    /**
     * Get all leads (with filters)
     */
    async getLeads(req, res) {
        try {
            const { page, limit, status, intent, search } = req.query;
            const filters = {};

            // Filter by owner (from JWT) - assumes auth middleware sets req.user
            if (req.user && req.user._id) {
                filters.user = req.user._id;
            }

            if (status) filters.status = status;
            if (intent) filters.intent = intent;

            if (search) {
                filters.$or = [
                    { 'caller.phoneNumber': { $regex: search, $options: 'i' } },
                    { 'caller.name': { $regex: search, $options: 'i' } },
                    { 'bookingDetails.notes': { $regex: search, $options: 'i' } }
                ];
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
            const lead = await leadService.getLeadById(req.params.id);

            // Permission check
            if (req.user && lead.user && lead.user._id.toString() !== req.user._id.toString()) {
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
            const lead = await leadService.updateLead(req.params.id, req.body);
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
            // Use service method (if exists, or direct db call via service)
            // For now using update to set cancelled or strict delete if implemented
            await leadService.updateLead(req.params.id, { status: 'CANCELLED' });
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
            const { status, intent } = req.query;
            const filters = {};
            if (req.user && req.user._id) filters.user = req.user._id;
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
