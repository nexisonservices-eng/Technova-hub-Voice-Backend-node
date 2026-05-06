import express from 'express';

import broadcastController from '../controllers/broadcastController.js';
import twilioWebhooks from '../webhooks/twilioWebhooks.js';
import { authenticate } from '../middleware/auth.js';
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';
import { resolveUserTwilioContext } from '../middleware/userTwilioContext.js';
import { requirePlanFeature } from '../middleware/planGuard.js';

const router = express.Router();

// 🔒 Protected broadcast routes (require authentication)
router.post('/start', authenticate, requirePlanFeature('voiceCampaign'), resolveUserTwilioContext, broadcastController.startBroadcast);
router.get('/status/:id', authenticate, broadcastController.getBroadcastStatus);
router.post('/bulk/cancel', authenticate, broadcastController.bulkCancelBroadcasts);
router.post('/bulk/delete', authenticate, broadcastController.bulkDeleteBroadcasts);
router.get('/:id/summary-details', authenticate, broadcastController.getBroadcastSummaryDetails);
router.post('/:id/cancel', authenticate, broadcastController.cancelBroadcast);
router.get('/:id/calls', authenticate, broadcastController.getBroadcastCalls);
router.get('/list', authenticate, broadcastController.listBroadcasts);
router.delete('/:id', authenticate, broadcastController.deleteBroadcast);

// 🌐 Twilio webhook routes (secured via Twilio signature)
router.post('/twiml', verifyTwilioRequest, twilioWebhooks.getBroadcastTwiML.bind(twilioWebhooks));
router.post('/:callId/status', verifyTwilioRequest, twilioWebhooks.handleCallStatus.bind(twilioWebhooks));
router.post('/keypress', verifyTwilioRequest, twilioWebhooks.handleKeypress.bind(twilioWebhooks));

export default router;
