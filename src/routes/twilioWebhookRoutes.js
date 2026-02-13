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

const router = express.Router();

/**
 * POST /webhook/twilio/voice
 * Handle incoming voice calls using existing IVR system
 */
router.post('/voice', async (req, res) => {
  try {
    const callData = req.body;
    const { CallSid, From, To, CallStatus } = callData;
    
    logger.info(`Incoming voice call: ${CallSid} from ${From} to ${To}`);

    // Use existing IVR controller welcome logic
    const ivrController = new IVRController();
    
    // Check if there's an active workflow first
    const activeWorkflow = await ivrController.getActiveWorkflow();
    
    if (activeWorkflow) {
      // Use existing workflow engine
      logger.info(`Using active workflow: ${activeWorkflow._id}`);
      
      // Start execution using existing workflow engine
      await ivrWorkflowEngine.startExecution(activeWorkflow._id, CallSid, From, To);
      
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
    
    logger.info(`Executing workflow ${workflowId} for call ${CallSid}`);
    
    // Determine user input
    const userInput = Digits || SpeechResult || null;
    
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
    const execution = await WorkflowExecution.findOne({ callSid: CallSid });
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
    
    logger.info(`Executing node ${nodeId} in workflow ${workflowId} for call ${CallSid}`);
    
    // Determine user input
    const userInput = Digits || SpeechResult || null;
    
    // Try existing workflow engine first
    try {
      const workflow = await Workflow.findById(workflowId);
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
    const execution = await WorkflowExecution.findOne({ callSid: CallSid });
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
    
    logger.info(`Voicemail recording completed: ${RecordingSid} for call ${callSid}`);
    
    // Handle voicemail completion
    await twilioIntegrationService.handleVoicemailComplete(recordingData);
    
    // Generate continuation TwiML
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    // Continue to next node in workflow
    const workflow = await Workflow.findById(workflowId);
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
    
    logger.info(`Voicemail transcription update: ${RecordingSid} -> ${TranscriptionStatus}`);
    
    // Update transcription in database
    const execution = await WorkflowExecution.findOne({ callSid: callSid });
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
    
    logger.info(`Call transfer completed: ${callSid} -> ${DialCallStatus}`);
    
    // Handle transfer completion
    await twilioIntegrationService.handleTransferComplete(transferData);
    
    // Generate continuation TwiML
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    // Continue to next node based on transfer result
    const workflow = await Workflow.findById(workflowId);
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
    
    logger.info(`AI assistant session completed: ${callSid} -> ${streamStatus}`);
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({ callSid: callSid });
    if (execution) {
      // Record AI session completion
      await execution.setVariable(`ai_session_${nodeId}_status`, streamStatus);
      await execution.setVariable(`ai_session_${nodeId}_completed`, new Date());
    }
    
    // Generate continuation TwiML
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    // Continue to next node
    const workflow = await Workflow.findById(workflowId);
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
    
    logger.info(`Call enqueued: ${CallSid} to queue ${queueName}`);
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({ callSid: CallSid });
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
    const { CallSid, QueueSid, QueuePosition, CurrentQueueSize } = req.body;
    
    logger.info(`Queue position update: ${CallSid} -> position ${QueuePosition} of ${CurrentQueueSize}`);
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({ callSid: CallSid });
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
    
    logger.info(`Call left queue: ${CallSid} -> ${QueueResult}`);
    
    // Update execution record
    const execution = await WorkflowExecution.findOne({ callSid: CallSid });
    if (execution) {
      await execution.setVariable('queue_result', QueueResult);
      await execution.setVariable('queue_leave_time', new Date());
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
