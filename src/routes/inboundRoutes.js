// routes/inboundRoutes.js
import express from 'express';
import InboundCallController from '../controllers/inboundCallController.js';
import inboundWebhooks from '../webhooks/inboundWebhooks.js';
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Create controller instance
const inboundCallController = new InboundCallController();

// 🌐 Public Twilio webhook endpoints (secured via Twilio signature)
router.post('/incoming', verifyTwilioRequest, inboundCallController.handleInboundCall.bind(inboundCallController));
router.post('/status', verifyTwilioRequest, inboundCallController.handleCallStatus.bind(inboundCallController));

// 📞 Enhanced webhook handlers for comprehensive inbound call management
router.post('/call/answered', verifyTwilioRequest, inboundWebhooks.handleCallAnswered.bind(inboundWebhooks));
router.post('/call/completed', verifyTwilioRequest, inboundWebhooks.handleCallCompleted.bind(inboundWebhooks));
router.post('/call/failed', verifyTwilioRequest, inboundWebhooks.handleCallFailed.bind(inboundWebhooks));
router.post('/call/machine-detection', verifyTwilioRequest, inboundWebhooks.handleMachineDetection.bind(inboundWebhooks));
router.post('/call/recording', verifyTwilioRequest, inboundWebhooks.handleRecording.bind(inboundWebhooks));
router.post('/call/dtmf', verifyTwilioRequest, inboundWebhooks.handleDTMF.bind(inboundWebhooks));
router.post('/call/transfer', verifyTwilioRequest, inboundWebhooks.handleTransfer.bind(inboundWebhooks));
router.post('/call/park', verifyTwilioRequest, inboundWebhooks.handlePark.bind(inboundWebhooks));

// 🎛️ IVR menu handling
router.post('/ivr/selection/:callSid', verifyTwilioRequest, inboundCallController.handleIVRSelection.bind(inboundCallController));

// 📬 Voicemail handling
router.post('/voicemail/:callSid', verifyTwilioRequest, inboundCallController.handleVoicemail.bind(inboundCallController));

// 📞 Callback handling
router.post('/callback/option/:callSid', verifyTwilioRequest, inboundCallController.handleCallbackOption.bind(inboundCallController));
router.post('/callback/number/:callSid', verifyTwilioRequest, inboundCallController.handleCallbackNumber.bind(inboundCallController));
router.post('/callback/status/:callbackId', verifyTwilioRequest, inboundWebhooks.handleCallbackStatus.bind(inboundWebhooks));

// 📞 Booking flow handling
router.post('/booking/input/:callSid', verifyTwilioRequest, inboundCallController.handleBookingInput.bind(inboundCallController));

// 👥 Conference and queue management
router.post('/conference/events', verifyTwilioRequest, inboundWebhooks.handleConferenceEvents.bind(inboundWebhooks));
router.post('/queue/status', verifyTwilioRequest, inboundWebhooks.handleQueueStatus.bind(inboundWebhooks));

// 💳 Payment processing (if enabled)
router.post('/payment/status', verifyTwilioRequest, inboundWebhooks.handlePaymentStatus.bind(inboundWebhooks));

// 🔒 Protected endpoints (JWT required) - for dashboard/management
router.get('/analytics', authenticate, inboundCallController.getInboundAnalytics.bind(inboundCallController));
router.get('/analytics/export', authenticate, inboundCallController.exportAnalytics.bind(inboundCallController));
router.get('/queues', authenticate, inboundCallController.getQueueStatus.bind(inboundCallController));
router.get('/queues/:queueName', authenticate, inboundCallController.getQueueStatus.bind(inboundCallController));

// 🎛️ IVR configuration management
router.get('/ivr/configs', authenticate, inboundCallController.getIVRConfigs.bind(inboundCallController));
router.post('/ivr/configs', authenticate, inboundCallController.updateIVRConfig.bind(inboundCallController));
router.delete('/ivr/configs/:menuId', authenticate, inboundCallController.deleteIVRConfig.bind(inboundCallController));

// 📞 Callback management
router.post('/callbacks/schedule', authenticate, inboundCallController.scheduleCallback.bind(inboundCallController));
router.get('/callbacks/stats', authenticate, inboundCallController.getCallbackStats.bind(inboundCallController));
router.get('/callbacks/active', authenticate, inboundCallController.getActiveCallbacks.bind(inboundCallController));
router.delete('/callbacks/:callbackId', authenticate, inboundCallController.cancelCallback.bind(inboundCallController));
router.put('/callbacks/:callbackId/reschedule', authenticate, inboundCallController.rescheduleCallback.bind(inboundCallController));
router.get('/callbacks/phone/:phoneNumber', authenticate, inboundCallController.getCallbacksByPhone.bind(inboundCallController));

// 👥 Agent management
router.get('/agents/stats', authenticate, inboundCallController.getAgentStats.bind(inboundCallController));
router.post('/agents', authenticate, inboundCallController.addAgent.bind(inboundCallController));
router.delete('/agents/:agentId', authenticate, inboundCallController.removeAgent.bind(inboundCallController));

export default router;
