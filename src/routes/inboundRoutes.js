// routes/inboundRoutes.js
import express from 'express';
import InboundCallController from '../controllers/inboundCallController.js';
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// 🌐 Public Twilio webhook endpoints (secured via Twilio signature)
router.post('/incoming', verifyTwilioRequest, InboundCallController.handleInboundCall.bind(InboundCallController));
router.post('/status', verifyTwilioRequest, InboundCallController.handleCallStatus.bind(InboundCallController));

// 🎛️ IVR menu handling
router.post('/ivr/selection/:callSid', verifyTwilioRequest, InboundCallController.handleIVRSelection.bind(InboundCallController));

// 📬 Voicemail handling
router.post('/voicemail/:callSid', verifyTwilioRequest, InboundCallController.handleVoicemail.bind(InboundCallController));

// 📞 Callback handling
router.post('/callback/option/:callSid', verifyTwilioRequest, InboundCallController.handleCallbackOption.bind(InboundCallController));
router.post('/callback/number/:callSid', verifyTwilioRequest, InboundCallController.handleCallbackNumber.bind(InboundCallController));

// 🔒 Protected endpoints (JWT required) - for dashboard/management
// Temporarily removed auth for testing
router.get('/analytics', InboundCallController.getInboundAnalytics.bind(InboundCallController));
router.get('/queues', InboundCallController.getQueueStatus.bind(InboundCallController));
router.get('/queues/:queueName', InboundCallController.getQueueStatus.bind(InboundCallController));

// 🎛️ IVR configuration management
// Temporarily removed auth for testing
router.get('/ivr/configs', InboundCallController.getIVRConfigs.bind(InboundCallController));
router.post('/ivr/configs', InboundCallController.updateIVRConfig.bind(InboundCallController));

export default router;
