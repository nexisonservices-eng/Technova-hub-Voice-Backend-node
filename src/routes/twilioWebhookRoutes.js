/**
 * Twilio Webhook Routes
 * Handles all Twilio webhooks for voice automation
 * Integrates with existing IVR and workflow systems
 */

import express from 'express';
import logger from '../utils/logger.js';
import twilioIntegrationService from '../services/twilioIntegrationService.js';
import inboundCallService from '../services/inboundCallService.js';
import WorkflowExecution from '../models/WorkflowExecution.js';
import Call from '../models/call.js';
import IVRController from '../controllers/ivrController.js';
import ivrWorkflowEngine from '../services/ivrWorkflowEngine.js';
import Workflow from '../models/Workflow.js';
import twilio from 'twilio';
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';
import adminCredentialsService from '../services/adminCredentialsService.js';
import outboundCampaignService from '../services/outboundCampaignService.js';
import { emitOutboundCallUpdate, emitQueueUpdate } from '../sockets/unifiedSocket.js';

const router = express.Router();

const normalizePhone = (value) => {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits}`;
};

const toPositiveInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
};

const resolveQueueName = (value) => {
  const text = String(value || '').trim();
  return text || 'General';
};

const resolveWebhookUserId = async (req) => {
  if (req.tenantContext?.adminId) {
    return String(req.tenantContext.adminId);
  }

  const toNumber = normalizePhone(req.body?.To || req.query?.To || '');
  if (!toNumber) return null;

  const tenant = await adminCredentialsService.getTwilioCredentialsByPhoneNumber(toNumber);
  if (!tenant?.userId) return null;

  req.tenantContext = {
    ...(req.tenantContext || {}),
    adminId: String(tenant.userId),
    toNumber,
    twilioAccountSid: tenant.twilioAccountSid || null,
  };

  return String(tenant.userId);
};

const resolveWebhookUserIdForCall = async (req, callSid) => {
  const fromNumber = await resolveWebhookUserId(req);
  if (fromNumber) return fromNumber;
  if (!callSid) return null;

  const execution = await WorkflowExecution.findOne({ callSid }).select('userId').lean();
  if (!execution?.userId) return null;

  req.tenantContext = {
    ...(req.tenantContext || {}),
    adminId: String(execution.userId),
  };

  return String(execution.userId);
};

const TERMINAL_OUTBOUND_STATUSES = new Set(['completed', 'failed', 'busy', 'no-answer', 'cancelled', 'canceled']);

const mapTwilioOutboundStatus = (status = '') => {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'canceled') return 'cancelled';
  return normalized;
};

const buildOutboundCallPayload = (call, status, duration = 0) => {
  const providerData = call?.providerData || {};
  const updatedAt = call?.updatedAt || new Date();
  return {
    _id: call?._id,
    callSid: call?.callSid || '',
    status,
    phoneNumber: call?.phoneNumber || '',
    provider: call?.provider || providerData.provider || '',
    duration: Number(call?.duration || duration || 0),
    campaignId: providerData.campaignId || '',
    campaignDbId: providerData.campaignDbId || '',
    campaignName: providerData.campaignName || '',
    contactId: providerData.contactId || '',
    workflowId: providerData.workflowId || '',
    voiceId: providerData.voiceId || '',
    createdAt: call?.createdAt || updatedAt,
    updatedAt,
    ended: TERMINAL_OUTBOUND_STATUSES.has(String(status || '').toLowerCase())
  };
};

const persistAndEmitOutboundCallStatus = async ({ callSid, status, duration = 0 }) => {
  if (!callSid || !status) return null;

  const ended = TERMINAL_OUTBOUND_STATUSES.has(status);
  const update = {
    status,
    ...(duration > 0 ? { duration } : {}),
    ...(ended ? { endTime: new Date() } : {})
  };

  const call = await Call.findOneAndUpdate(
    {
      callSid,
      direction: 'outbound-local',
      deletedAt: null
    },
    { $set: update },
    { new: true }
  ).lean();

  if (!call) return null;

  const payload = buildOutboundCallPayload(call, status, duration);
  emitOutboundCallUpdate(String(call.user || ''), payload);
  return { call, payload };
};

/**
 * POST /webhooks/twilio/inbound (also available under /webhook/twilio/inbound)
 * Public inbound webhook endpoint for Twilio number voice URL.
 * Must stay unauthenticated and return TwiML directly with HTTP 200.
 */
router.post('/inbound', async (req, res) => {
  try {
    const callData = req.body;
    const { CallSid, From, To } = callData;
    const webhookUserId = await resolveWebhookUserId(req);

    logger.info(`Inbound webhook hit: ${CallSid} from ${From} to ${To}`);

    if (!webhookUserId) {
      logger.warn(`Unable to resolve tenant for inbound call ${CallSid} to ${To}`);
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      response.say({ voice: 'alice' }, 'We apologize, but this service is currently unavailable.');
      response.hangup();
      return res.status(200).type('text/xml').send(response.toString());
    }

    const result = await inboundCallService.processIncomingCall({
      CallSid,
      From,
      To,
      userId: webhookUserId
    });

    return res.status(200).type('text/xml').send(result.twiml);
  } catch (error) {
    logger.error('Error handling inbound webhook:', error);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, 'We apologize, but our service is temporarily unavailable. Please try again later.');
    response.hangup();
    return res.status(200).type('text/xml').send(response.toString());
  }
});

router.use((req, res, next) => {
  if (req.path === '/inbound') return next();
  if (req.method === 'GET') return next();
  return verifyTwilioRequest(req, res, next);
});

/**
 * POST /webhook/twilio/voice
 * Handle incoming voice calls using existing IVR system
 */
router.post('/voice', async (req, res) => {
  try {
    const callData = req.body;
    const { CallSid, From, To, CallStatus } = callData;
    const webhookUserId = req.tenantContext?.adminId || null;
    
    logger.info(`Incoming voice call: ${CallSid} from ${From} to ${To}`);

    const resolvedUserId = webhookUserId || await resolveWebhookUserId(req);
    const result = await inboundCallService.processIncomingCall({
      CallSid,
      From,
      To,
      CallStatus,
      userId: resolvedUserId
    });

    res.type('text/xml');
    res.send(result.twiml);
  } catch (error) {
    logger.error('Error handling incoming call:', error);
    
    // Use existing error handling from IVR system
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, 'We apologize, but our service is temporarily unavailable. Please try again later.');
    response.hangup();
    
    res.type('text/xml');
    res.send(response.toString());
  }
});

/**
 * POST /webhook/twilio/status
 * Handle call status updates using existing systems
 */
router.post('/status', async (req, res) => {
  try {
    const callData = req.body;
    const { CallSid, CallStatus } = callData;
    
    logger.info(`Call status update: ${CallSid} -> ${CallStatus}`);

    // Use existing IVR controller for status handling
    const ivrController = new IVRController();
    
    // Create mock request/response for existing controller
    const mockReq = { body: callData };
    const mockRes = {
      status: () => {},
      send: () => {},
      sendStatus: () => {}
    };
    
    // Use existing status handling
    await ivrController.handleCallStatus(mockReq, mockRes);
    
    // Also update in new integration service for tracking
    const execution = await twilioIntegrationService.handleCallStatusUpdate(callData);
    
    // Emit status update via Socket.IO (existing logic)
    if (execution) {
      const io = req.app.get('io');
      if (io) {
        io.emit('call_status_update', {
          callSid: CallSid,
          status: CallStatus,
          execution: execution
        });
      }
    }

    const mappedStatus = mapTwilioOutboundStatus(CallStatus);
    const duration = toPositiveInt(callData?.CallDuration || callData?.Duration || 0);
    if (mappedStatus) {
      await persistAndEmitOutboundCallStatus({
        callSid: CallSid,
        status: mappedStatus,
        duration
      });
      const campaignStatus =
        mappedStatus === 'cancelled' || mappedStatus === 'canceled'
          ? 'failed'
          : mappedStatus === 'in-progress'
            ? 'answered'
            : mappedStatus;
      await outboundCampaignService.syncCallUpdate(CallSid, campaignStatus, duration);
    }
    
    res.sendStatus(204);
  } catch (error) {
    logger.error('Error handling call status update:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /webhook/twilio/workflow/:workflowId
 * Execute workflow node using existing workflow engine
 */
router.post('/workflow/:workflowId', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { Digits, SpeechResult, CallSid } = req.body;
    const webhookUserId = await resolveWebhookUserId(req);
    
    logger.info(`Executing workflow ${workflowId} for call ${CallSid}`);
    
    if (!webhookUserId) {
      logger.warn(`Tenant resolution failed for workflow callback ${workflowId} call ${CallSid}`);
      return res.status(403).send('Forbidden: tenant context missing');
    }

    // Determine user input
    const userInput = Digits || SpeechResult || null;
    const workflow = await Workflow.findOne({ _id: workflowId, createdBy: webhookUserId }).select('_id');
    if (!workflow) {
      logger.warn(`Workflow ${workflowId} not found for tenant ${webhookUserId}`);
      return res.status(404).send('Workflow not found');
    }
    
    // Use existing workflow engine first
    try {
      // Get execution state from existing system
      const executionState = ivrWorkflowEngine.getExecutionState(CallSid);
      
      if (executionState) {
        logger.info('Using existing workflow engine state');
        
        // Handle user input using existing system
        const nextNodeId = await ivrWorkflowEngine.handleUserInput(workflowId, executionState.currentNodeId, userInput, CallSid);
        
        if (nextNodeId) {
          // Generate TwiML for next node using existing system
          const twiml = await ivrWorkflowEngine.generateTwiML(workflowId, nextNodeId, userInput, CallSid);
          
          res.type('text/xml');
          res.send(twiml);
          return;
        }
      }
    } catch (existingError) {
      logger.warn('Existing workflow engine failed, falling back to new integration:', existingError.message);
    }
    
    // Fallback to new integration service
    logger.info('Using new integration service for workflow execution');
    
    // Get execution record
    const execution = await WorkflowExecution.findOne({
      callSid: CallSid,
      ...(webhookUserId ? { userId: webhookUserId } : {})
    });
    if (!execution) {
      logger.warn(`No execution found for call ${CallSid}`);
      return res.status(404).send('Execution not found');
    }
    
    // Generate TwiML for workflow
    const twiml = await twilioIntegrationService.generateTwiML(workflowId, null, userInput, CallSid);
    
    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    logger.error('Error executing workflow:', error);
    
    // Use existing error handling
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, 'We apologize, but an error occurred. Please try again later.');
    response.hangup();
    
    res.type('text/xml');
    res.send(response.toString());
  }
});

/**
 * POST /webhook/twilio/workflow/:workflowId/node/:nodeId
 * Execute specific workflow node using existing systems
 */
router.post('/workflow/:workflowId/node/:nodeId', async (req, res) => {
  try {
    const { workflowId, nodeId } = req.params;
    const { CallSid, Digits, SpeechResult } = req.body;
    const webhookUserId = await resolveWebhookUserId(req);
    
    logger.info(`Executing node ${nodeId} in workflow ${workflowId} for call ${CallSid}`);
    
    if (!webhookUserId) {
      logger.warn(`Tenant resolution failed for node callback ${workflowId}/${nodeId} call ${CallSid}`);
      return res.status(403).send('Forbidden: tenant context missing');
    }

    // Determine user input
    const userInput = Digits || SpeechResult || null;
    
    // Try existing workflow engine first
    try {
      const workflow = await Workflow.findOne({
        _id: workflowId,
        ...(webhookUserId ? { createdBy: webhookUserId } : {})
      });
      if (workflow) {
        logger.info('Using existing IVR workflow system');
        
        // Use existing workflow engine to generate TwiML
        const twiml = await ivrWorkflowEngine.generateTwiML(workflowId, nodeId, userInput, CallSid);
        
        res.type('text/xml');
        res.send(twiml);
        return;
      }
    } catch (existingError) {
      logger.warn('Existing IVR system failed, falling back to new integration:', existingError.message);
    }
    
    // Fallback to new integration service
    logger.info('Using new integration service for node execution');
    
    // Get execution record
    const execution = await WorkflowExecution.findOne({
      callSid: CallSid,
      ...(webhookUserId ? { userId: webhookUserId } : {})
    });
    if (!execution) {
      logger.warn(`No execution found for call ${CallSid}`);
      return res.status(404).send('Execution not found');
    }
    
    // Generate TwiML for specific node
    const twiml = await twilioIntegrationService.generateTwiML(workflowId, nodeId, userInput, CallSid);
    
    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    logger.error('Error executing workflow node:', error);
    
    // Use existing error handling
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, 'We apologize, but an error occurred. Please try again later.');
    response.hangup();
    
    res.type('text/xml');
    res.send(response.toString());
  }
});

/**
 * POST /webhook/twilio/voicemail/complete
 * Handle voicemail recording completion
 */
router.post('/voicemail/complete', async (req, res) => {
  try {
    const recordingData = req.body;
    const { RecordingSid, RecordingUrl, Duration, callSid, workflowId, nodeId } = recordingData;
    const webhookUserId = await resolveWebhookUserIdForCall(req, callSid);
    if (!webhookUserId) {
      logger.warn(`Tenant resolution failed for voicemail completion call ${callSid}`);
      return res.sendStatus(403);
    }
    
    logger.info(`Voicemail recording completed: ${RecordingSid} for call ${callSid}`);
    
    // Handle voicemail completion
    await twilioIntegrationService.handleVoicemailComplete(recordingData);
    
    // Generate continuation TwiML
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    // Continue to next node in workflow
    const workflow = await Workflow.findOne({
      _id: workflowId,
      ...(webhookUserId ? { createdBy: webhookUserId } : {})
    });
    if (workflow) {
      const edge = workflow.edges.find(e => e.source === nodeId);
      if (edge) {
        response.redirect(`/webhook/twilio/workflow/${workflowId}/node/${edge.target}`);
      } else {
        response.say('Thank you for your message. Goodbye.');
        response.hangup();
      }
    } else {
      response.say('Thank you for your message. Goodbye.');
      response.hangup();
    }
    
    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Error handling voicemail completion:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /webhook/twilio/voicemail/status
 * Handle voicemail transcription status
 */
router.post('/voicemail/status', async (req, res) => {
  try {
    const { RecordingSid, TranscriptionText, TranscriptionStatus, callSid } = req.body;
    const webhookUserId = await resolveWebhookUserIdForCall(req, callSid);
    if (!webhookUserId) {
      logger.warn(`Tenant resolution failed for voicemail status call ${callSid}`);
      return res.sendStatus(403);
    }
    
    logger.info(`Voicemail transcription update: ${RecordingSid} -> ${TranscriptionStatus}`);
    
    // Update transcription in database
    const execution = await WorkflowExecution.findOne({
      callSid: callSid,
      userId: webhookUserId
    });
    if (execution && TranscriptionText) {
      await execution.updateTranscription(RecordingSid, TranscriptionText);
      
      // Emit transcription update via Socket.IO
      const io = req.app.get('io');
      if (io) {
        io.emit('voicemail_transcription', {
          callSid: callSid,
          recordingSid: RecordingSid,
          transcription: TranscriptionText,
          status: TranscriptionStatus
        });
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error handling voicemail status:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /webhook/twilio/transfer/complete
 * Handle call transfer completion
 */
router.post('/transfer/complete', async (req, res) => {
  try {
    const transferData = req.body;
    const { DialCallStatus, DialCallDuration, callSid, workflowId, nodeId } = transferData;
    const webhookUserId = await resolveWebhookUserIdForCall(req, callSid);
    if (!webhookUserId) {
      logger.warn(`Tenant resolution failed for transfer completion call ${callSid}`);
      return res.sendStatus(403);
    }
    
    logger.info(`Call transfer completed: ${callSid} -> ${DialCallStatus}`);
    
    // Handle transfer completion
    await twilioIntegrationService.handleTransferComplete(transferData);
    
    // Generate continuation TwiML
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    // Continue to next node based on transfer result
    const workflow = await Workflow.findOne({
      _id: workflowId,
      createdBy: webhookUserId
    });
    if (workflow) {
      const handle = DialCallStatus === 'answered' ? 'answered' : 'failed';
      const edge = workflow.edges.find(e => 
        e.source === nodeId && e.sourceHandle === handle
      );
      
      if (edge) {
        response.redirect(`/webhook/twilio/workflow/${workflowId}/node/${edge.target}`);
      } else {
        response.say('Thank you for calling. Goodbye.');
        response.hangup();
      }
    } else {
      response.say('Thank you for calling. Goodbye.');
      response.hangup();
    }
    
    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Error handling transfer completion:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /webhook/twilio/ai/complete
 * Handle AI assistant session completion
 */
router.post('/ai/complete', async (req, res) => {
  try {
    const { callSid, workflowId, nodeId, streamStatus } = req.body;
    const webhookUserId = await resolveWebhookUserIdForCall(req, callSid);
    if (!webhookUserId) {
      logger.warn(`Tenant resolution failed for AI completion call ${callSid}`);
      return res.sendStatus(403);
    }
    
    logger.info(`AI assistant session completed: ${callSid} -> ${streamStatus}`);
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({
      callSid: callSid,
      userId: webhookUserId
    });
    if (execution) {
      // Record AI session completion
      await execution.setVariable(`ai_session_${nodeId}_status`, streamStatus);
      await execution.setVariable(`ai_session_${nodeId}_completed`, new Date());
    }
    
    // Generate continuation TwiML
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    // Continue to next node
    const workflow = await Workflow.findOne({
      _id: workflowId,
      createdBy: webhookUserId
    });
    if (workflow) {
      const edge = workflow.edges.find(e => e.source === nodeId);
      if (edge) {
        response.redirect(`/webhook/twilio/workflow/${workflowId}/node/${edge.target}`);
      } else {
        response.say('Thank you for using our AI assistant. Goodbye.');
        response.hangup();
      }
    } else {
      response.say('Thank you for using our AI assistant. Goodbye.');
      response.hangup();
    }
    
    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Error handling AI completion:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /webhook/twilio/enqueue
 * Handle call enqueueing
 */
router.post('/enqueue', async (req, res) => {
  try {
    const { CallSid, queueName, From, Caller } = req.body;
    const webhookUserId = await resolveWebhookUserIdForCall(req, CallSid);
    if (!webhookUserId) logger.warn(`Tenant resolution failed for enqueue call ${CallSid}`);

    const normalizedQueueName = resolveQueueName(queueName);
    const enqueueTime = new Date();
    const phoneNumber = normalizePhone(From || Caller || '');
    
    logger.info(`Call enqueued: ${CallSid} to queue ${normalizedQueueName}`);
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({
      callSid: CallSid,
      ...(webhookUserId ? { userId: webhookUserId } : {})
    });
    if (execution) {
      await execution.setVariable('queue_name', normalizedQueueName);
      await execution.setVariable('queue_timestamp', new Date());
    }

    await Call.findOneAndUpdate(
      {
        callSid: CallSid,
        ...(webhookUserId ? { user: webhookUserId } : {})
      },
      {
        $set: {
          queued: true,
          queueName: normalizedQueueName,
          queuePosition: 0,
          queueWaitTime: 0,
          queueLeftAt: null,
          queueResult: '',
          ...(phoneNumber ? { phoneNumber } : {})
        }
      }
    );

    await Call.updateOne(
      {
        callSid: CallSid,
        ...(webhookUserId ? { user: webhookUserId } : {}),
        $or: [{ queueEnteredAt: null }, { queueEnteredAt: { $exists: false } }]
      },
      { $set: { queueEnteredAt: enqueueTime } }
    );
    
    // Generate queue TwiML
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    response.enqueue({
      waitUrl: '/webhook/twilio/queue/wait',
      action: '/webhook/twilio/queue/leave'
    }, normalizedQueueName);
    
    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Error handling enqueue:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /webhook/twilio/queue/wait
 * Handle queue wait music/announcements
 */
router.post('/queue/wait', async (req, res) => {
  try {
    const { CallSid, QueueSid, QueuePosition, CurrentQueueSize, queueName } = req.body;
    const webhookUserId = await resolveWebhookUserIdForCall(req, CallSid);
    if (!webhookUserId) logger.warn(`Tenant resolution failed for queue wait call ${CallSid}`);

    const callRecord = await Call.findOne({
      callSid: CallSid,
      ...(webhookUserId ? { user: webhookUserId } : {})
    }).select('queueName phoneNumber queueEnteredAt');
    const normalizedQueueName = resolveQueueName(queueName || callRecord?.queueName);
    logger.info(`Queue position update: ${CallSid} -> ${normalizedQueueName} position ${QueuePosition} of ${CurrentQueueSize}`);

    const phoneNumber = normalizePhone(req.body?.From || req.body?.Caller || callRecord?.phoneNumber || '');
    const syncResult = inboundCallService.syncQueueFromWebhook({
      callSid: CallSid,
      queueName: normalizedQueueName,
      userId: webhookUserId || null,
      phoneNumber,
      position: toPositiveInt(QueuePosition, 1),
      queuedAt: callRecord?.queueEnteredAt || null,
      priority: 'normal'
    });
    const queueEntry = syncResult?.entry || null;
    const queueWaitTimeSeconds = queueEntry?.queuedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(queueEntry.queuedAt).getTime()) / 1000))
      : 0;
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({
      callSid: CallSid,
      ...(webhookUserId ? { userId: webhookUserId } : {})
    });
    if (execution) {
      await execution.setVariable('queue_position', QueuePosition);
      await execution.setVariable('queue_size', CurrentQueueSize);
    }

    await Call.findOneAndUpdate(
      {
        callSid: CallSid,
        ...(webhookUserId ? { user: webhookUserId } : {})
      },
      {
        $set: {
          queued: true,
          queueName: normalizedQueueName,
          queueEnteredAt: queueEntry?.queuedAt || callRecord?.queueEnteredAt || new Date(),
          queueLeftAt: null,
          queueResult: '',
          queuePosition: toPositiveInt(queueEntry?.position, toPositiveInt(QueuePosition, 1)),
          queueWaitTime: queueWaitTimeSeconds,
          ...(phoneNumber ? { phoneNumber } : {})
        }
      }
    );
    
    emitQueueUpdate({
      userId: webhookUserId || null,
      queueName: normalizedQueueName,
      callSid: CallSid,
      position: toPositiveInt(queueEntry?.position, toPositiveInt(QueuePosition, 1)),
      queueSize: toPositiveInt(CurrentQueueSize, syncResult?.queueLength || 0),
      queueStatus: inboundCallService.getAllQueueStatus(webhookUserId || null)
    });
    
    // Generate wait TwiML
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    response.say({ voice: 'alice' }, `You are currently position ${QueuePosition} in the queue. Please hold for the next available agent.`);
    response.play('https://api.twilio.com/cowbell.mp3');
    
    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Error handling queue wait:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /webhook/twilio/queue/leave
 * Handle leaving queue
 */
router.post('/queue/leave', async (req, res) => {
  try {
    const { CallSid, QueueResult, queueName } = req.body;
    const webhookUserId = await resolveWebhookUserIdForCall(req, CallSid);
    if (!webhookUserId) logger.warn(`Tenant resolution failed for queue leave call ${CallSid}`);
    
    logger.info(`Call left queue: ${CallSid} -> ${QueueResult}`);

    const callRecord = await Call.findOne({
      callSid: CallSid,
      ...(webhookUserId ? { user: webhookUserId } : {})
    }).select('queueName queueEnteredAt queueWaitTime status');
    const normalizedQueueName = resolveQueueName(queueName || callRecord?.queueName);
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({
      callSid: CallSid,
      ...(webhookUserId ? { userId: webhookUserId } : {})
    });
    if (execution) {
      await execution.setVariable('queue_result', QueueResult);
      await execution.setVariable('queue_leave_time', new Date());
    }

    let removed = inboundCallService.removeFromQueue(CallSid, normalizedQueueName);
    if (!removed) {
      removed = inboundCallService.removeFromAnyQueue(CallSid);
    }

    const queueLeftAt = new Date();
    const queueEnteredAt = callRecord?.queueEnteredAt ? new Date(callRecord.queueEnteredAt) : null;
    const finalQueueWaitTime = queueEnteredAt
      ? Math.max(0, Math.floor((queueLeftAt.getTime() - queueEnteredAt.getTime()) / 1000))
      : Math.max(0, Number(callRecord?.queueWaitTime) || 0);
    const normalizedResult = String(QueueResult || '').trim().toLowerCase();
    const statusUpdate = normalizedResult === 'timeout'
      ? { status: 'no-answer' }
      : normalizedResult === 'completed'
        ? { status: 'completed' }
        : normalizedResult === 'failed'
          ? { status: 'failed' }
          : {};

    await Call.findOneAndUpdate(
      {
        callSid: CallSid,
        ...(webhookUserId ? { user: webhookUserId } : {})
      },
      {
        $set: {
          queued: false,
          queuePosition: 0,
          queueWaitTime: finalQueueWaitTime,
          queueLeftAt,
          queueResult: String(QueueResult || ''),
          ...statusUpdate
        }
      }
    );

    emitQueueUpdate({
      userId: webhookUserId || null,
      queueName: normalizedQueueName,
      callSid: CallSid,
      action: removed ? 'left' : 'left_noop',
      result: QueueResult,
      queueStatus: inboundCallService.getAllQueueStatus(webhookUserId || null)
    });
    
    // Generate response based on queue result
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    if (QueueResult === 'bridged') {
      response.say('Connecting you to an agent now.');
    } else if (QueueResult === 'timeout') {
      response.say('All agents are currently busy. Please try again later or leave a message.');
      // Could redirect to voicemail here
    } else {
      response.say('Thank you for waiting. Goodbye.');
    }
    
    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Error handling queue leave:', error);
    res.sendStatus(500);
  }
});

/**
 * GET /webhook/twilio/health
 * Health check for webhook service
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'twilio_webhooks',
    timestamp: new Date().toISOString(),
    activeCalls: twilioIntegrationService.getActiveCalls().length
  });
});

export default router;
