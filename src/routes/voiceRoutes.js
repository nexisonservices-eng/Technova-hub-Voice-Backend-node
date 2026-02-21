// routes/VoiceRoutes.js
import express from 'express';
import CallController from '../controllers/voiceController.js';
import { authenticate } from '../middleware/auth.js';
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';

const router = express.Router();

// 🔒 Protected routes
router.post('/call/outbound', authenticate, CallController.startOutboundCall);
router.get('/calls/active', authenticate, CallController.getActiveCalls);
router.post('/call/:callSid/end', authenticate, CallController.endCall);

// 🌐 Twilio webhook
router.post('/call/incoming', verifyTwilioRequest, CallController.handleInboundCall);

// 🔒 Call details
router.get('/call/:callSid', authenticate, CallController.getCallDetails);

// 📊 Stats
router.get('/stats', authenticate, CallController.getCallStats);

export default router;
