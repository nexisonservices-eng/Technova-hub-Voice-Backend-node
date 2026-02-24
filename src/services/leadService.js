import Lead from '../models/Lead.js';
import logger from '../utils/logger.js';

class LeadService {
    /**
     * Create a new lead from a call
     */
    async createLead(leadData) {
        try {
            logger.info(`Creating new lead for caller: ${leadData.caller.phoneNumber}`);
            const lead = new Lead(leadData);
            await lead.save();
            logger.info(`Lead created successfully: ${lead._id}`);
            return lead;
        } catch (error) {
            logger.error('Error creating lead:', error);
            throw error;
        }
    }

    /**
     * Get leads with filtering and pagination
     */
    async getLeads(filters = {}, options = {}) {
        try {
            const { page = 1, limit = 10, sort = '-createdAt' } = options;
            const skip = (page - 1) * limit;

            const query = Lead.find(filters)
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .populate('assignedAgent', 'name email')
                .populate('user', 'name company');

            const total = await Lead.countDocuments(filters);

            const leads = await query;

            return {
                leads,
                pagination: {
                    total,
                    page: parseInt(page),
                    pages: Math.ceil(total / limit),
                    hasMore: skip + leads.length < total
                }
            };
        } catch (error) {
            logger.error('Error fetching leads:', error);
            throw error;
        }
    }

    /**
     * Get single lead by ID
     */
    async getLeadById(leadId, userId = null) {
        try {
            const query = { _id: leadId };
            if (userId) query.user = userId;
            const lead = await Lead.findOne(query)
                .populate('assignedAgent', 'name email')
                .populate('user');

            if (!lead) throw new Error('Lead not found');
            return lead;
        } catch (error) {
            logger.error(`Error fetching lead ${leadId}:`, error);
            throw error;
        }
    }

    /**
     * Update lead details
     */
    async updateLead(leadId, updates, userId = null) {
        try {
            const filter = { _id: leadId };
            if (userId) filter.user = userId;
            const lead = await Lead.findOneAndUpdate(
                filter,
                { $set: updates },
                { new: true, runValidators: true }
            ).populate('assignedAgent', 'name email');

            if (!lead) throw new Error('Lead not found');

            logger.info(`Lead updated: ${leadId}`);
            return lead;
        } catch (error) {
            logger.error(`Error updating lead ${leadId}:`, error);
            throw error;
        }
    }

    /**
     * Assign lead to agent
     */
    async assignAgent(leadId, agentId) {
        return this.updateLead(leadId, {
            assignedAgent: agentId,
            status: 'IN_PROGRESS'
        });
    }

    /**
     * Add AI analysis to lead
     */
    async addAIAnalysis(leadId, analysis) {
        return this.updateLead(leadId, { aiAnalysis: analysis });
    }

    /**
     * Add audio recording metadata
     */
    async addRecording(leadId, recordingData) {
        try {
            const lead = await Lead.findById(leadId);
            if (!lead) throw new Error('Lead not found');

            lead.audioRecordings.push(recordingData);
            await lead.save();

            return lead;
        } catch (error) {
            logger.error(`Error adding recording to lead ${leadId}:`, error);
            throw error;
        }
    }
}

export default new LeadService();
