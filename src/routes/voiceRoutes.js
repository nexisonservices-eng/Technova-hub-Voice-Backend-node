// routes/voiceRoutes.js
import express from 'express';
import CallController from "../controllers/voiceController.js";
import { authenticate } from '../middleware/auth.js';
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';

const router = express.Router();

// 🔒 Protected routes (JWT required)
router.post('/call/outbound', authenticate, CallController.startOutboundCall.bind(CallController));
router.get('/calls/active', authenticate, CallController.getActiveCalls.bind(CallController));

// 🌐 Public Twilio webhook (secured via Twilio signature)
router.post('/call/incoming', verifyTwilioRequest, CallController.handleInboundCall.bind(CallController));

// 🔒 Get call details by CallSid (JWT required)
router.get('/call/:callSid', authenticate, CallController.getCallDetails.bind(CallController));

// 📊 Stats endpoint (for compatibility - mounted at /voice but accessed via /api)
router.get('/stats', authenticate, CallController.getCallStats.bind(CallController));

export default router;
