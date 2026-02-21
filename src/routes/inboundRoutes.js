// routes/inboundRoutes.js
import express from 'express';
import InboundCallController from '../controllers/inboundCallController.js';
import inboundWebhooks from '../webhooks/inboundWebhooks.js';
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';
import { authenticate } from '../middleware/auth.js';
import InboundRoutingRule from '../models/InboundRoutingRule.js';
import Workflow from '../models/Workflow.js';
import mongoose from 'mongoose';
import twilio from 'twilio';

const router = express.Router();

// Create controller instance
const inboundCallController = new InboundCallController();

const mapRuleResponse = (rule) => ({
  id: String(rule._id),
  name: rule.name,
  priority: rule.priority,
  condition: rule.condition,
  action: rule.action,
  actionType: rule.actionType || 'custom',
  ivrMenuId: rule.ivrMenuId || '',
  ivrPromptKey: rule.ivrPromptKey || '',
  enabled: Boolean(rule.enabled)
});

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

// Routing rules compatibility endpoints
router.get('/routing/rules', authenticate, async (req, res) => {
  try {
    const rules = await InboundRoutingRule.find({})
      .sort({ priority: 1, updatedAt: -1 })
      .lean();

    res.json({
      success: true,
      data: rules.map((rule) => mapRuleResponse(rule))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/routing/rules', authenticate, async (req, res) => {
  try {
    const incomingRule = req.body || {};
    const payload = {
      name: String(incomingRule.name || '').trim(),
      priority: Number.isFinite(Number(incomingRule.priority)) ? Number(incomingRule.priority) : 1,
      condition: String(incomingRule.condition || '').trim(),
      action: String(incomingRule.action || '').trim(),
      actionType: incomingRule.actionType === 'ivr' ? 'ivr' : 'custom',
      ivrMenuId: String(incomingRule.ivrMenuId || '').trim(),
      ivrPromptKey: String(incomingRule.ivrPromptKey || '').trim(),
      enabled: typeof incomingRule.enabled === 'boolean' ? incomingRule.enabled : true
    };

    if (!payload.name || !payload.condition) {
      return res.status(400).json({ success: false, error: 'name and condition are required' });
    }

    if (payload.actionType === 'ivr') {
      if (!payload.ivrPromptKey) {
        return res.status(400).json({ success: false, error: 'ivrPromptKey is required for IVR actions' });
      }
      if (!payload.action) {
        payload.action = `ivr:${payload.ivrPromptKey}`;
      }
    } else if (!payload.action) {
      return res.status(400).json({ success: false, error: 'action is required for custom actions' });
    }

    let savedRule;
    const id = incomingRule.id || incomingRule._id;
    if (id) {
      savedRule = await InboundRoutingRule.findByIdAndUpdate(
        id,
        { $set: payload },
        { new: true, runValidators: true }
      );
      if (!savedRule) {
        return res.status(404).json({ success: false, error: 'Routing rule not found' });
      }
    } else {
      savedRule = await InboundRoutingRule.create(payload);
    }

    res.json({
      success: true,
      data: mapRuleResponse(savedRule)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/routing/rules/:ruleId', authenticate, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const deleted = await InboundRoutingRule.findByIdAndDelete(ruleId);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Routing rule not found' });
    }
    res.json({ success: true, data: { id: ruleId, deleted: true } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/routing/rules/:ruleId/toggle', authenticate, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const rule = await InboundRoutingRule.findById(ruleId);

    if (!rule) {
      return res.status(404).json({ success: false, error: 'Routing rule not found' });
    }

    rule.enabled = !rule.enabled;
    await rule.save();

    res.json({
      success: true,
      data: mapRuleResponse(rule)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/routing/rules/:ruleId/test', authenticate, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const { callSid, phoneNumber } = req.body || {};

    const rule = await InboundRoutingRule.findById(ruleId);
    if (!rule) {
      return res.status(404).json({ success: false, error: 'Routing rule not found' });
    }

    const isIvrRule = rule.actionType === 'ivr' || String(rule.action || '').startsWith('ivr:');
    if (!isIvrRule) {
      return res.status(400).json({
        success: false,
        error: 'Only IVR-linked rules can be tested with the Play action'
      });
    }

    const promptFromAction = String(rule.action || '').startsWith('ivr:')
      ? String(rule.action || '').slice(4).trim()
      : '';
    const ivrPromptKey = String(rule.ivrPromptKey || promptFromAction || '').trim();

    let menu = null;
    if (rule.ivrMenuId && mongoose.Types.ObjectId.isValid(rule.ivrMenuId)) {
      menu = await Workflow.findOne({ _id: rule.ivrMenuId, isActive: true });
    }
    if (!menu && ivrPromptKey) {
      menu = await Workflow.findOne({ promptKey: ivrPromptKey, isActive: true });
    }

    if (!menu) {
      return res.status(404).json({
        success: false,
        error: 'Linked IVR menu not found or inactive'
      });
    }

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say(
      { voice: 'alice', language: 'en-US' },
      menu.text || `Welcome to ${menu.displayName || menu.promptKey}`
    );

    const inputNodes = (menu.nodes || []).filter((node) => node.type === 'input' && node?.data?.digit);
    if (inputNodes.length > 0) {
      const gather = response.gather({
        numDigits: 1,
        timeout: menu.config?.timeout || 10,
        action: `/webhook/ivr/selection/${callSid || 'test'}`,
        method: 'POST'
      });

      inputNodes.forEach((node) => {
        const label = node?.data?.label || node?.data?.action || `option ${node?.data?.digit}`;
        gather.say({ voice: 'alice', language: 'en-US' }, `For ${label}, press ${node.data.digit}.`);
      });
    }

    res.json({
      success: true,
      message: phoneNumber
        ? `IVR test simulation generated for ${phoneNumber}`
        : 'IVR test simulation generated',
      result: {
        rule: mapRuleResponse(rule),
        workflow: {
          id: String(menu._id),
          promptKey: menu.promptKey,
          displayName: menu.displayName || menu.promptKey
        },
        greeting: menu.text || '',
        optionCount: inputNodes.length,
        twiml: response.toString()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
