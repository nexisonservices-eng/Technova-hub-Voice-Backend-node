/**
 * Outbound Configuration Routes
 * RESTful API for campaign templates and contact lists
 */
import express from 'express';
import OutboundConfigController from '../controllers/outboundConfigController.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Campaign Template Routes
router.get('/templates', OutboundConfigController.getTemplates.bind(OutboundConfigController));
router.post('/templates', validate('outboundCampaign'), OutboundConfigController.createTemplate.bind(OutboundConfigController));
router.put('/templates/:id', OutboundConfigController.updateTemplate.bind(OutboundConfigController));
router.delete('/templates/:id', OutboundConfigController.deleteTemplate.bind(OutboundConfigController));

// Contact List Routes
router.get('/contact-lists', OutboundConfigController.getContactLists.bind(OutboundConfigController));
router.post('/contact-lists', OutboundConfigController.createContactList.bind(OutboundConfigController));
router.put('/contact-lists/:id', OutboundConfigController.updateContactList.bind(OutboundConfigController));
router.delete('/contact-lists/:id', OutboundConfigController.deleteContactList.bind(OutboundConfigController));

export default router;
