/**
 * Twilio Webhook Routes
 * Handles all Twilio webhooks for voice automation
 * Integrates with existing IVR and workflow systems
 */

import express from 'express';
import logger from '../utils/logger.js';
import twilioIntegrationService from '../services/twilioIntegrationService.js';
import IVRExecutionEngine from '../services/ivrExecutionEngine.js';
import WorkflowExecution from '../models/WorkflowExecution.js';
import IVRController from '../controllers/ivrController.js';
import ivrWorkflowEngine from '../services/ivrWorkflowEngine.js';
import Workflow from '../models/Workflow.js';
import ExecutionLog from '../models/ExecutionLog.js';
import twilio from 'twilio';
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';
import adminCredentialsService from '../services/adminCredentialsService.js';

const router = express.Router();

const normalizePhone = (value) => {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits}`;
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

    const activeWorkflow = await Workflow.findOne({
      status: 'active',
      isActive: true,
      createdBy: webhookUserId
    }).sort({ updatedAt: -1 });

    if (activeWorkflow) {
      await ivrWorkflowEngine.startExecution(
        activeWorkflow._id,
        CallSid,
        From,
        To,
        webhookUserId
      );

      const firstNodeId = activeWorkflow.nodes?.[0]?.id || null;
      if (firstNodeId) {
        const twiml = await ivrWorkflowEngine.generateTwiML(activeWorkflow._id, firstNodeId, null, CallSid);
        return res.status(200).type('text/xml').send(twiml);
      }
    }

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, 'Thank you for calling. Please hold while we connect you.');
    response.hangup();

    return res.status(200).type('text/xml').send(response.toString());
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

    // Use existing IVR controller welcome logic
    const ivrController = new IVRController();
    
    // Check if there's an active workflow first
    const activeWorkflow = await ivrController.getActiveWorkflow(webhookUserId);
    
    if (activeWorkflow) {
      // Use existing workflow engine
      logger.info(`Using active workflow: ${activeWorkflow._id}`);
      
      // Start execution using existing workflow engine
      await ivrWorkflowEngine.startExecution(
        activeWorkflow._id,
        CallSid,
        From,
        To,
        webhookUserId || activeWorkflow.createdBy || null
      );
      
      // Generate TwiML using existing system
      const twiml = await ivrWorkflowEngine.generateTwiML(activeWorkflow._id, activeWorkflow.nodes[0].id, null, CallSid);
      
      res.type('text/xml');
      res.send(twiml);
    } else {
      // Fallback to new integration service
      logger.info('No active workflow found, using new integration service');
      
      const execution = await twilioIntegrationService.handleIncomingCall(callData);
      const twiml = await twilioIntegrationService.generateTwiML(execution.workflowId);
      
      res.type('text/xml');
      res.send(twiml);
    }
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
      send: () => {}
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
    
    res.sendStatus(200);
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
    const { CallSid, queueName } = req.body;
    const webhookUserId = await resolveWebhookUserIdForCall(req, CallSid);
    if (!webhookUserId) {
      logger.warn(`Tenant resolution failed for enqueue call ${CallSid}`);
      return res.sendStatus(403);
    }
    
    logger.info(`Call enqueued: ${CallSid} to queue ${queueName}`);
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({
      callSid: CallSid,
      userId: webhookUserId
    });
    if (execution) {
      await execution.setVariable('queue_name', queueName);
      await execution.setVariable('queue_timestamp', new Date());
    }
    
    // Generate queue TwiML
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    response.enqueue({
      waitUrl: '/webhook/twilio/queue/wait',
      action: '/webhook/twilio/queue/leave'
    }, queueName || 'General');
    
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
    if (!webhookUserId) {
      logger.warn(`Tenant resolution failed for queue wait call ${CallSid}`);
      return res.sendStatus(403);
    }
    
    logger.info(`Queue position update: ${CallSid} -> position ${QueuePosition} of ${CurrentQueueSize}`);
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({
      callSid: CallSid,
      userId: webhookUserId
    });
    if (execution) {
      await execution.setVariable('queue_position', QueuePosition);
      await execution.setVariable('queue_size', CurrentQueueSize);
    }
    
    // Emit queue update via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('queue_position_update', {
        callSid: CallSid,
        queueSid: QueueSid,
        position: QueuePosition,
        queueSize: CurrentQueueSize
      });
      io.emit('caller_joined_queue', {
        callSid: CallSid,
        queueName: queueName || 'General',
        caller: {
          callSid: CallSid,
          queuedAt: new Date().toISOString()
        }
      });
      io.emit('queue_update', {
        queueName: queueName || 'General',
        callSid: CallSid,
        position: QueuePosition,
        queueSize: CurrentQueueSize
      });
    }
    
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
    const { CallSid, QueueResult } = req.body;
    const webhookUserId = await resolveWebhookUserIdForCall(req, CallSid);
    if (!webhookUserId) {
      logger.warn(`Tenant resolution failed for queue leave call ${CallSid}`);
      return res.sendStatus(403);
    }
    
    logger.info(`Call left queue: ${CallSid} -> ${QueueResult}`);
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({
      callSid: CallSid,
      userId: webhookUserId
    });
    if (execution) {
      await execution.setVariable('queue_result', QueueResult);
      await execution.setVariable('queue_leave_time', new Date());
    }

    // Emit queue leave event via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('caller_left_queue', {
        queueName: 'General',
        callSid: CallSid,
        result: QueueResult
      });
    }
    
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
