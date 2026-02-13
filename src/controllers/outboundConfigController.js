/**
 * Outbound Configuration Controller
 * Manages outbound campaign templates and configurations
 */
import ResponseFormatter from '../utils/responseFormatter.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';

// Campaign Template Schema
const campaignTemplateSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
    description: String,
    greeting: {
        type: String,
        maxLength: 500
    },
    voicemailMessage: {
        type: String,
        maxLength: 500
    },
    retryLogic: {
        maxAttempts: {
            type: Number,
            default: 3,
            min: 1,
            max: 5
        },
        retryDelay: {
            type: Number,
            default: 3600, // seconds (1 hour)
            min: 300, // 5 minutes
            max: 86400 // 24 hours
        },
        retryOnStatus: {
            type: [String],
            default: ['no-answer', 'busy', 'failed']
        }
    },
    callSettings: {
        recordCall: {
            type: Boolean,
            default: false
        },
        machineDetection: {
            type: Boolean,
            default: false
        },
        timeout: {
            type: Number,
            default: 60 // seconds
        }
    },
    contactLists: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ContactList'
    }],
    isActive: {
        type: Boolean,
        default: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true
});

// Contact List Schema
const contactListSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    description: String,
    contacts: [{
        phoneNumber: {
            type: String,
            required: true,
            match: /^\+?[1-9]\d{1,14}$/ // E.164 format
        },
        customData: mongoose.Schema.Types.Mixed
    }],
    totalContacts: {
        type: Number,
        default: 0
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true
});

// Create models
const CampaignTemplate = mongoose.models.CampaignTemplate ||
    mongoose.model('CampaignTemplate', campaignTemplateSchema);
const ContactList = mongoose.models.ContactList ||
    mongoose.model('ContactList', contactListSchema);

class OutboundConfigController {
    /**
     * Get all campaign templates
     * GET /api/outbound-config/templates
     */
    async getTemplates(req, res) {
        try {
            const { page = 1, limit = 20, search } = req.query;

            const filter = { isActive: true };
            if (search) {
                filter.$or = [
                    { name: new RegExp(search, 'i') },
                    { description: new RegExp(search, 'i') }
                ];
            }

            const skip = (parseInt(page) - 1) * parseInt(limit);
            const limitNum = parseInt(limit);

            const [templates, total] = await Promise.all([
                CampaignTemplate.find(filter)
                    .populate('createdBy', 'name email')
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum)
                    .lean(),
                CampaignTemplate.countDocuments(filter)
            ]);

            logger.info(`Retrieved ${templates.length} campaign templates`);

            res.json(ResponseFormatter.paginated(
                templates,
                parseInt(page),
                limitNum,
                total
            ));

        } catch (error) {
            logger.error('Get templates error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'GET_TEMPLATES_ERROR')
            );
        }
    }

    /**
     * Create campaign template
     * POST /api/outbound-config/templates
     */
    async createTemplate(req, res) {
        try {
            const templateData = {
                ...req.body,
                createdBy: req.user?._id
            };

            const template = new CampaignTemplate(templateData);
            await template.save();

            logger.info(`Campaign template created: ${template.name}`);

            res.status(201).json(
                ResponseFormatter.created(template, template._id)
            );

        } catch (error) {
            logger.error('Create template error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'CREATE_TEMPLATE_ERROR')
            );
        }
    }

    /**
     * Update campaign template
     * PUT /api/outbound-config/templates/:id
     */
    async updateTemplate(req, res) {
        try {
            const { id } = req.params;

            const template = await CampaignTemplate.findByIdAndUpdate(
                id,
                { $set: req.body },
                { new: true, runValidators: true }
            );

            if (!template) {
                return res.status(404).json(
                    ResponseFormatter.notFound('Campaign template')
                );
            }

            logger.info(`Campaign template updated: ${template.name}`);

            res.json(ResponseFormatter.success(template));

        } catch (error) {
            logger.error('Update template error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'UPDATE_TEMPLATE_ERROR')
            );
        }
    }

    /**
     * Delete campaign template
     * DELETE /api/outbound-config/templates/:id
     */
    async deleteTemplate(req, res) {
        try {
            const { id } = req.params;

            const template = await CampaignTemplate.findByIdAndUpdate(
                id,
                { $set: { isActive: false } },
                { new: true }
            );

            if (!template) {
                return res.status(404).json(
                    ResponseFormatter.notFound('Campaign template')
                );
            }

            logger.info(`Campaign template deleted: ${template.name}`);

            res.json(ResponseFormatter.success({
                templateId: id,
                deletedAt: new Date()
            }));

        } catch (error) {
            logger.error('Delete template error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'DELETE_TEMPLATE_ERROR')
            );
        }
    }

    /**
     * Get all contact lists
     * GET /api/outbound-config/contact-lists
     */
    async getContactLists(req, res) {
        try {
            const { page = 1, limit = 20 } = req.query;

            const skip = (parseInt(page) - 1) * parseInt(limit);
            const limitNum = parseInt(limit);

            const [lists, total] = await Promise.all([
                ContactList.find()
                    .populate('createdBy', 'name email')
                    .select('-contacts') // Exclude contacts array for list view
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum)
                    .lean(),
                ContactList.countDocuments()
            ]);

            logger.info(`Retrieved ${lists.length} contact lists`);

            res.json(ResponseFormatter.paginated(
                lists,
                parseInt(page),
                limitNum,
                total
            ));

        } catch (error) {
            logger.error('Get contact lists error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'GET_CONTACT_LISTS_ERROR')
            );
        }
    }

    /**
     * Create contact list
     * POST /api/outbound-config/contact-lists
     */
    async createContactList(req, res) {
        try {
            const { name, description, contacts } = req.body;

            const contactList = new ContactList({
                name,
                description,
                contacts: contacts || [],
                totalContacts: contacts?.length || 0,
                createdBy: req.user?._id
            });

            await contactList.save();

            logger.info(`Contact list created: ${contactList.name} with ${contactList.totalContacts} contacts`);

            res.status(201).json(
                ResponseFormatter.created(contactList, contactList._id)
            );

        } catch (error) {
            logger.error('Create contact list error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'CREATE_CONTACT_LIST_ERROR')
            );
        }
    }

    /**
     * Update contact list
     * PUT /api/outbound-config/contact-lists/:id
     */
    async updateContactList(req, res) {
        try {
            const { id } = req.params;
            const { name, description, contacts } = req.body;

            const update = { name, description };
            if (contacts) {
                update.contacts = contacts;
                update.totalContacts = contacts.length;
            }

            const contactList = await ContactList.findByIdAndUpdate(
                id,
                { $set: update },
                { new: true, runValidators: true }
            );

            if (!contactList) {
                return res.status(404).json(
                    ResponseFormatter.notFound('Contact list')
                );
            }

            logger.info(`Contact list updated: ${contactList.name}`);

            res.json(ResponseFormatter.success(contactList));

        } catch (error) {
            logger.error('Update contact list error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'UPDATE_CONTACT_LIST_ERROR')
            );
        }
    }

    /**
     * Delete contact list
     * DELETE /api/outbound-config/contact-lists/:id
     */
    async deleteContactList(req, res) {
        try {
            const { id } = req.params;

            const contactList = await ContactList.findByIdAndDelete(id);

            if (!contactList) {
                return res.status(404).json(
                    ResponseFormatter.notFound('Contact list')
                );
            }

            logger.info(`Contact list deleted: ${contactList.name}`);

            res.json(ResponseFormatter.success({
                listId: id,
                deletedAt: new Date()
            }));

        } catch (error) {
            logger.error('Delete contact list error:', error);
            res.status(500).json(
                ResponseFormatter.error(error.message, 'DELETE_CONTACT_LIST_ERROR')
            );
        }
    }
}

export default new OutboundConfigController();
