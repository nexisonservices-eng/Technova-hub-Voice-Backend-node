import Lead from '../models/Lead.js';
import logger from '../utils/logger.js';
import { emitLeadUpdate } from '../sockets/unifiedSocket.js';

const normalizePaginationNumber = (value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
};

class LeadService {
    /**
     * Create a new lead from a call
     */
    async createLead(leadData) {
        try {
            logger.info(`Creating new lead for caller: ${leadData?.caller?.phoneNumber || 'unknown'}`);
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
            const page = normalizePaginationNumber(options.page, 1);
            const limit = normalizePaginationNumber(options.limit, 50, { min: 1, max: 100 });
            const sort = options.sort || { createdAt: 1, _id: 1 };
            const skip = (page - 1) * limit;

            const query = Lead.find(filters)
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .populate('assignedAgent', 'name email')
                .populate('user', 'name company')
                .lean({ virtuals: true });

            const [total, leads] = await Promise.all([
                Lead.countDocuments(filters),
                query
            ]);

            const totalPages = Math.ceil(total / limit);

            return {
                leads,
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages,
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
            emitLeadUpdate(lead.user ? String(lead.user) : null, {
                action: 'updated',
                lead
            });
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

    /**
     * Upsert lead by callSid (+ user when available)
     * Guarantees one lead record per call for a tenant/user.
     */
    async upsertLeadByCallSid(leadData = {}) {
        try {
            const callSid = String(leadData.callSid || '').trim();
            if (!callSid) {
                throw new Error('callSid is required for lead upsert');
            }

            const filter = { callSid };
            if (leadData.user) {
                filter.user = leadData.user;
            }

            const existingLead = await Lead.findOne(filter).select('_id').lean();

            const update = {
                $set: {
                    ...leadData
                }
            };

            const lead = await Lead.findOneAndUpdate(
                filter,
                update,
                {
                    new: true,
                    upsert: true,
                    runValidators: true,
                    setDefaultsOnInsert: true
                }
            );

            logger.info(`Lead upserted for callSid: ${callSid}`);
            emitLeadUpdate(lead.user ? String(lead.user) : null, {
                action: existingLead ? 'updated' : 'created',
                lead
            });
            return lead;
        } catch (error) {
            logger.error(`Error upserting lead for callSid ${leadData?.callSid || 'unknown'}:`, error);
            throw error;
        }
    }
}

export default new LeadService();
