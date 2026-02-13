/**
 * Twilio Integration Service
 * Handles all Twilio-related operations for workflow execution
 */

import twilio from 'twilio';
import logger from '../utils/logger.js';
import WorkflowExecution from '../models/WorkflowExecution.js';
import Workflow from '../models/Workflow.js';
import { EventEmitter } from 'events';

class TwilioIntegrationService extends EventEmitter {
  constructor() {
    super();
    
    // Initialize Twilio client
    this.accountSid = process.env.TWILIO_ACCOUNT_SID;
    this.authToken = process.env.TWILIO_AUTH_TOKEN;
    this.phoneNumber = process.env.TWILIO_PHONE_NUMBER;
    
    if (!this.accountSid || !this.authToken) {
      logger.warn('Twilio credentials not found in environment variables');
      this.client = null;
    } else {
      this.client = twilio(this.accountSid, this.authToken);
      logger.info('Twilio client initialized');
    }
    
    // Active calls tracking
    this.activeCalls = new Map(); // callSid -> call data
  }

  /**
   * Initialize Twilio webhook handlers
   */
  initializeWebhooks() {
    if (!this.client) {
      throw new Error('Twilio client not initialized');
    }
    
    logger.info('Twilio webhook handlers initialized');
  }

  /**
   * Handle incoming call webhook
   */
  async handleIncomingCall(callData) {
    try {
      const { CallSid, From, To, CallStatus, Direction, FromCountry, FromState, FromCity } = callData;
      
      logger.info(`Incoming call: ${CallSid} from ${From} to ${To}`);
      
      // Create workflow execution record
      const execution = new WorkflowExecution({
        callSid: CallSid,
        callerNumber: From,
        destinationNumber: To,
        status: 'running',
        twilioData: {
          callStatus: CallStatus,
          callDirection: Direction || 'inbound',
          fromCountry: FromCountry,
          fromState: FromState,
          fromCity: FromCity
        }
      });
      
      await execution.save();
      
      // Track active call
      this.activeCalls.set(CallSid, {
        execution,
        startTime: new Date(),
        callData
      });
      
      // Emit event for other services
      this.emit('incoming_call', { callSid: CallSid, execution, callData });
      
      return execution;
    } catch (error) {
      logger.error('Error handling incoming call:', error);
      throw error;
    }
  }

  /**
   * Handle call status updates
   */
  async handleCallStatusUpdate(callData) {
    try {
      const { CallSid, CallStatus, CallDuration, AnsweredBy } = callData;
      
      logger.info(`Call status update: ${CallSid} -> ${CallStatus}`);
      
      // Find execution
      const execution = await WorkflowExecution.findOne({ callSid: CallSid });
      if (!execution) {
        logger.warn(`No execution found for call ${CallSid}`);
        return null;
      }
      
      // Update Twilio data
      const updateData = {
        callStatus: CallStatus
      };
      
      if (AnsweredBy) updateData.answeredBy = AnsweredBy;
      if (CallDuration) updateData.callDuration = parseInt(CallDuration);
      
      await execution.updateTwilioStatus(CallStatus, updateData);
      
      // Clean up active calls if ended
      if (['completed', 'busy', 'no-answer', 'canceled', 'failed'].includes(CallStatus)) {
        this.activeCalls.delete(CallSid);
        this.emit('call_ended', { callSid: CallSid, execution, status: CallStatus });
      }
      
      return execution;
    } catch (error) {
      logger.error('Error handling call status update:', error);
      throw error;
    }
  }

  /**
   * Generate TwiML for workflow execution
   */
  async generateTwiML(workflowId, nodeId = null, userInput = null, callSid = null) {
    try {
      // Get workflow configuration
      const workflow = await Workflow.findById(workflowId);
      if (!workflow) {
        logger.error(`Workflow not found: ${workflowId}`);
        return this.createErrorResponse('Workflow not found');
      }
      
      // Get execution if callSid provided
      let execution = null;
      if (callSid) {
        execution = await WorkflowExecution.findOne({ callSid: callSid });
      }
      
      // Determine which node to execute
      let targetNode = nodeId;
      const { nodes } = this.getWorkflowParts(workflow);
      if (!targetNode && nodes.length > 0) {
        targetNode = nodes[0].id; // Start node
      }
      
      const node = nodes.find(n => n.id === targetNode);
      if (!node) {
        logger.error(`Node not found: ${targetNode}`);
        return this.createErrorResponse('Node not found');
      }
      
      // Generate TwiML based on node type
      const twiml = await this.generateNodeTwiML(node, workflow, execution, userInput);
      
      return twiml;
    } catch (error) {
      logger.error('Error generating TwiML:', error);
      return this.createErrorResponse('Service temporarily unavailable');
    }
  }

  /**
   * Generate TwiML for specific node
   */
  async generateNodeTwiML(node, workflow, execution = null, userInput = null) {
    const response = new VoiceResponse();
    
    const { data } = node;
    const { settings } = this.getWorkflowParts(workflow);
    
    try {
      switch (node.type) {
        case 'greeting':
        case 'menu':
          await this.handleGreetingNode(response, data, settings, workflow, node.id);
          break;
        
        case 'audio':
          await this.handleGreetingNode(response, data, settings, workflow, node.id);
          break;
          
        case 'input':
          await this.handleInputNode(response, data, settings, workflow, node.id, execution);
          break;
          
        case 'conditional':
          await this.handleConditionalNode(response, data, workflow, node.id, execution);
          break;
          
        case 'voicemail':
          await this.handleVoicemailNode(response, data, settings, workflow, node.id, execution);
          break;
          
        case 'transfer':
          await this.handleTransferNode(response, data, workflow, node.id, execution);
          break;
          
        case 'repeat':
          await this.handleRepeatNode(response, data, workflow, node.id, execution);
          break;
          
        case 'end':
          await this.handleEndNode(response, data, settings);
          break;
          
        case 'ai_assistant':
          await this.handleAIAssistantNode(response, data, workflow, node.id, execution);
          break;
          
        default:
          logger.warn(`Unknown node type: ${node.type}`);
          response.say({ voice: 'alice' }, 'An error occurred. Unknown step.');
          response.hangup();
      }
      
      // Record node visit if execution exists
      if (execution) {
        await execution.recordNodeVisit(node.id, node.type, userInput);
      }
      
      return response.toString();
    } catch (error) {
      logger.error(`Error generating TwiML for node ${node.id}:`, error);
      
      if (execution) {
        await execution.recordNodeVisit(node.id, node.type, userInput, 0, false, error.message);
      }
      
      return this.createErrorResponse('Service temporarily unavailable');
    }
  }

  /**
   * Handle greeting/menu node
   */
  async handleGreetingNode(response, data, settings, workflow, nodeId) {
    const voice = this.normalizeTwilioVoice(data.voice || settings.voice || settings.voiceId);
    const language = data.language || settings.language || 'en-GB';
    const text = this.getNodeText(data, 'Welcome.');
    
    if (data.audioUrl) {
      response.play(data.audioUrl);
    } else if (text) {
      // Generate audio from text using TTS service
      try {
        const pythonTTSService = (await import('../services/pythonTTSService.js')).default;
        const promptKey = `workflow_${workflow._id}_node_${nodeId}`;
        const audioResult = await pythonTTSService.getAudioForPrompt(promptKey, text, language, data.voice, workflow._id, { id: nodeId, type: 'audio' });
        const audioUrl = audioResult?.audioUrl;
        
        if (audioUrl) {
          response.play(audioUrl);
        } else {
          // Fallback to Twilio TTS if custom TTS fails
          response.say({ voice, language }, text);
        }
      } catch (error) {
        logger.error('TTS generation failed, using Twilio fallback:', error);
        response.say({ voice, language }, text);
      }
    } else {
      response.say({ voice, language }, 'Welcome.');
    }
    
    // Auto-advance to next node
    this.appendNextStep(response, workflow, nodeId);
  }

  /**
   * Handle user input node
   */
  async handleInputNode(response, data, settings, workflow, nodeId, execution) {
    const voice = this.normalizeTwilioVoice(data.voice || settings.voice || settings.voiceId);
    const language = data.language || settings.language || 'en-GB';
    const text = this.getNodeText(data, 'Please select an option.');
    
    // Check if this is a retry
    const attemptCount = execution ? execution.userInputs.filter(ui => ui.nodeId === nodeId).length : 0;
    
    if (attemptCount >= 1 && data.invalidInputMessage) {
      // Generate audio for invalid input message
      try {
        const pythonTTSService = (await import('../services/pythonTTSService.js')).default;
        const promptKey = `workflow_${workflow._id}_node_${nodeId}_invalid`;
        const audioResult = await pythonTTSService.getAudioForPrompt(
          promptKey,
          data.invalidInputMessage,
          language,
          data.voice,
          workflow._id,
          { id: nodeId, type: 'input' }
        );
        const audioUrl = audioResult?.audioUrl;
        
        if (audioUrl) {
          response.play(audioUrl);
        } else {
          response.say({ voice, language }, data.invalidInputMessage);
        }
      } catch (error) {
        logger.error('TTS generation for invalid input failed:', error);
        response.say({ voice, language }, data.invalidInputMessage);
      }
    }
    
    const gather = response.gather({
      input: data.inputType === 'speech' ? 'speech' : 'dtmf',
      timeout: data.timeout || settings.timeout || 10,
      action: `/ivr/workflow/${workflow._id}/node/${nodeId}`,
      method: 'POST',
      numDigits: data.numDigits,
      finishOnKey: data.finishOnKey,
      speechTimeout: data.speechTimeout,
      speechModel: data.speechModel
    });
    
    if (data.audioUrl) {
      gather.play(data.audioUrl);
    } else if (text) {
      // Generate audio for main prompt text
      try {
        const pythonTTSService = (await import('../services/pythonTTSService.js')).default;
        const promptKey = `workflow_${workflow._id}_node_${nodeId}`;
        const audioResult = await pythonTTSService.getAudioForPrompt(promptKey, text, language, data.voice, workflow._id, { id: nodeId, type: 'input' });
        const audioUrl = audioResult?.audioUrl;
        
        if (audioUrl) {
          gather.play(audioUrl);
        } else {
          gather.say({ voice, language }, text);
        }
      } catch (error) {
        logger.error('TTS generation for input prompt failed:', error);
        gather.say({ voice, language }, text);
      }
    } else {
      gather.say({ voice, language }, 'Please select an option.');
    }
  }

  /**
   * Handle conditional node
   */
  async handleConditionalNode(response, data, workflow, nodeId, execution) {
    if (!execution) {
      response.say('Error: No execution context found.');
      response.hangup();
      return;
    }
    
    // Get variable value
    const actualValue = execution.getVariable(data.variable);
    
    // Evaluate condition
    let isMatch = false;
    switch (data.operator) {
      case 'equals': isMatch = (actualValue == data.value); break;
      case 'not_equals': isMatch = (actualValue != data.value); break;
      case 'contains': isMatch = String(actualValue).includes(data.value); break;
      case 'greater_than': isMatch = Number(actualValue) > Number(data.value); break;
      case 'less_than': isMatch = Number(actualValue) < Number(data.value); break;
      case 'exists': isMatch = (actualValue !== undefined && actualValue !== null); break;
      default: isMatch = false;
    }
    
    logger.info(`Condition Evaluation: [${data.variable}](${actualValue}) ${data.operator} [${data.value}] = ${isMatch}`);
    
    // Find the correct edge based on result
    const targetHandle = isMatch ? 'true' : 'false';
    const { edges } = this.getWorkflowParts(workflow);
    const edge = edges.find(e => 
      e.source === nodeId && e.sourceHandle === targetHandle
    );
    
    if (edge) {
      response.redirect(`/ivr/workflow/${workflow._id}/node/${edge.target}`);
    } else {
      // Fallback
      response.say('No path found for this condition.');
      response.hangup();
    }
  }

  /**
   * Handle voicemail node
   */
  async handleVoicemailNode(response, data, settings, workflow, nodeId, execution) {
    const voice = this.normalizeTwilioVoice(data.voice || settings.voice || settings.voiceId);
    const language = data.language || settings.language || 'en-GB';
    
    if (this.getNodeText(data)) {
      response.say({ voice, language }, this.getNodeText(data));
    }
    
    const recordAction = `/ivr/voicemail/complete?workflowId=${workflow._id}&nodeId=${nodeId}&callSid=${execution?.callSid}`;
    
    response.record({
      action: recordAction,
      maxLength: data.maxLength || 60,
      playBeep: data.playBeep !== false,
      transcribe: data.transcribe || false,
      timeout: data.silenceTimeout || 5,
      recordingStatusCallback: `/ivr/voicemail/status?callSid=${execution?.callSid}`
    });
  }

  /**
   * Handle transfer node
   */
  async handleTransferNode(response, data, workflow, nodeId, execution) {
    if (data.announceText) {
      response.say(data.announceText);
    }
    
    const dial = response.dial({
      callerId: data.callerId || this.phoneNumber,
      timeout: data.timeout || 30,
      record: data.record || false,
      action: `/ivr/transfer/complete?workflowId=${workflow._id}&nodeId=${nodeId}&callSid=${execution?.callSid}`
    });
    
    const destination = data.destination || data.transferNumber;
    if (!destination) {
      logger.error(`Transfer node ${nodeId} missing destination/transferNumber`);
      response.say({ voice: 'alice', language: 'en-GB' }, 'We are unable to transfer your call right now.');
      this.appendNextStep(response, workflow, nodeId, 'failed');
      return;
    }

    dial.number(destination);
    
    // Record transfer attempt
    if (execution) {
      await execution.recordTransfer(destination, 'initiated');
    }
  }

  /**
   * Handle repeat node
   */
  async handleRepeatNode(response, data, workflow, nodeId, execution) {
    if (!execution) {
      response.say('Error: No execution context found.');
      response.hangup();
      return;
    }
    
    // Get repeat count
    const repeatKey = `repeat_${nodeId}`;
    const repeatCount = execution.getVariable(repeatKey) || 0;
    
    if (repeatCount >= data.maxRepeats) {
      // Max repeats reached
      if (data.fallbackNodeId) {
        response.redirect(`/ivr/workflow/${workflow._id}/node/${data.fallbackNodeId}`);
      } else {
        this.appendNextStep(response, workflow, nodeId, 'fallback');
      }
    } else {
      // Increment repeat count
      await execution.setVariable(repeatKey, repeatCount + 1);
      
      if (data.repeatMessage) {
        response.say(data.repeatMessage);
      }
      
      // Go back to previous node or specified node
      const lastNode = execution.visitedNodes[execution.visitedNodes.length - 2];
      if (lastNode && data.replayLastPrompt !== false) {
        response.redirect(`/ivr/workflow/${workflow._id}/node/${lastNode.nodeId}`);
      } else {
        this.appendNextStep(response, workflow, nodeId);
      }
    }
  }

  /**
   * Handle end node
   */
  async handleEndNode(response, data, settings) {
    const voice = this.normalizeTwilioVoice(data.voice || settings.voice || settings.voiceId);
    const language = data.language || settings.language || 'en-GB';
    
    if (this.getNodeText(data)) {
      const endMessage = this.getNodeText(data);
      // Generate audio for end message
      try {
        const pythonTTSService = (await import('../services/pythonTTSService.js')).default;
        const promptKey = `end_node_${Date.now()}`;
        const audioResult = await pythonTTSService.getAudioForPrompt(promptKey, endMessage, language, data.voice);
        const audioUrl = audioResult?.audioUrl;
        
        if (audioUrl) {
          response.play(audioUrl);
        } else {
          response.say({ voice, language }, endMessage);
        }
      } catch (error) {
        logger.error('TTS generation for end message failed:', error);
        response.say({ voice, language }, endMessage);
      }
    }
    
    response.hangup();
  }

  /**
   * Handle AI assistant node
   */
  async handleAIAssistantNode(response, data, workflow, nodeId, execution) {
    if (data.welcomeMessage) {
      response.say(data.welcomeMessage);
    }
    
    const connect = response.connect({
      action: `/ivr/ai/complete?workflowId=${workflow._id}&nodeId=${nodeId}&callSid=${execution?.callSid}`
    });
    
    connect.stream({
      url: data.streamUrl,
      track: 'both_tracks'
    });
  }

  /**
   * Append next step redirect
   */
  appendNextStep(response, workflow, currentNodeId, handle = null) {
    const { edges } = this.getWorkflowParts(workflow);
    const edge = edges.find(e =>
      e.source === currentNodeId && (!handle || e.sourceHandle === handle)
    );
    
    if (edge) {
      response.redirect(`/ivr/workflow/${workflow._id}/node/${edge.target}`);
    }
  }

  /**
   * Create error response
   */
  createErrorResponse(message = 'Service temporarily unavailable') {
    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, message);
    response.hangup();
    return response.toString();
  }

  getWorkflowParts(workflow) {
    const nodes = Array.isArray(workflow?.nodes)
      ? workflow.nodes
      : (Array.isArray(workflow?.workflowConfig?.nodes) ? workflow.workflowConfig.nodes : []);
    const edges = Array.isArray(workflow?.edges)
      ? workflow.edges
      : (Array.isArray(workflow?.workflowConfig?.edges) ? workflow.workflowConfig.edges : []);
    const settings = workflow?.config || workflow?.workflowConfig?.settings || {};
    return { nodes, edges, settings };
  }

  getNodeText(data = {}, fallback = null) {
    return data?.messageText || data?.text || data?.message || fallback;
  }

  normalizeTwilioVoice(voice) {
    if (!voice || /Neural$/i.test(voice)) return 'alice';
    return voice;
  }

  /**
   * Handle voicemail completion
   */
  async handleVoicemailComplete(recordingData) {
    try {
      const { RecordingSid, RecordingUrl, Duration, callSid, workflowId, nodeId } = recordingData;
      
      const execution = await WorkflowExecution.findOne({ callSid: callSid });
      if (!execution) {
        logger.warn(`No execution found for voicemail: ${callSid}`);
        return;
      }
      
      // Record voicemail
      await execution.recordVoicemail(RecordingUrl, RecordingSid, null, parseInt(Duration));
      
      // Continue workflow
      const workflow = await Workflow.findById(workflowId);
      if (workflow) {
        this.appendNextStep(null, workflow, nodeId);
      }
      
      logger.info(`Voicemail recorded for call ${callSid}: ${RecordingSid}`);
    } catch (error) {
      logger.error('Error handling voicemail completion:', error);
    }
  }

  /**
   * Handle transfer completion
   */
  async handleTransferComplete(transferData) {
    try {
      const { DialCallStatus, DialCallDuration, callSid, workflowId, nodeId } = transferData;
      
      const execution = await WorkflowExecution.findOne({ callSid: callSid });
      if (!execution) {
        logger.warn(`No execution found for transfer: ${callSid}`);
        return;
      }
      
      // Update transfer info
      const transferStatus = this.mapDialStatusToTransferStatus(DialCallStatus);
      await execution.recordTransfer(execution.transferInfo.transferredTo, transferStatus);
      
      if (transferStatus === 'completed') {
        execution.transferInfo.transferDuration = parseInt(DialCallDuration);
      }
      
      // Continue workflow based on result
      const workflow = await Workflow.findById(workflowId);
      if (workflow) {
        const handle = transferStatus === 'completed' ? 'answered' : 'failed';
        this.appendNextStep(null, workflow, nodeId, handle);
      }
      
      logger.info(`Transfer completed for call ${callSid}: ${transferStatus}`);
    } catch (error) {
      logger.error('Error handling transfer completion:', error);
    }
  }

  /**
   * Map Twilio dial status to transfer status
   */
  mapDialStatusToTransferStatus(dialStatus) {
    const mapping = {
      'answered': 'completed',
      'busy': 'rejected',
      'no-answer': 'rejected',
      'failed': 'failed',
      'canceled': 'failed'
    };
    
    return mapping[dialStatus] || 'failed';
  }

  /**
   * Get active calls
   */
  getActiveCalls() {
    return Array.from(this.activeCalls.entries()).map(([callSid, data]) => ({
      callSid,
      ...data
    }));
  }

  /**
   * Get call statistics
   */
  async getCallStatistics(startDate = null, endDate = null) {
    try {
      const matchQuery = {};
      
      if (startDate || endDate) {
        matchQuery.startTime = {};
        if (startDate) matchQuery.startTime.$gte = startDate;
        if (endDate) matchQuery.startTime.$lte = endDate;
      }
      
      const stats = await WorkflowExecution.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: null,
            totalCalls: { $sum: 1 },
            completedCalls: {
              $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
            },
            failedCalls: {
              $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
            },
            avgDuration: { $avg: '$duration' },
            totalDuration: { $sum: '$duration' }
          }
        }
      ]);
      
      return stats[0] || {
        totalCalls: 0,
        completedCalls: 0,
        failedCalls: 0,
        avgDuration: 0,
        totalDuration: 0
      };
    } catch (error) {
      logger.error('Error getting call statistics:', error);
      throw error;
    }
  }
}

export default new TwilioIntegrationService();
