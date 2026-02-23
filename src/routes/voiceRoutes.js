// routes/VoiceRoutes.js
import express from 'express';
import CallController from '../controllers/voiceController.js';
import { authenticate } from '../middleware/auth.js';
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';
import { resolveUserTwilioContext } from '../middleware/userTwilioContext.js';

const router = express.Router();

// 🔒 Protected routes
router.post('/call/outbound', authenticate, resolveUserTwilioContext, CallController.startOutboundCall);
router.get('/calls/active', authenticate, resolveUserTwilioContext, CallController.getActiveCalls);
router.post('/call/:callSid/end', authenticate, resolveUserTwilioContext, CallController.endCall);

// 🌐 Twilio webhook
router.post('/call/incoming', verifyTwilioRequest, CallController.handleInboundCall);

// 🔒 Call details
router.get('/call/:callSid', authenticate, resolveUserTwilioContext, CallController.getCallDetails);

// 📊 Stats
router.get('/stats', authenticate, resolveUserTwilioContext, CallController.getCallStats);

export default router;
