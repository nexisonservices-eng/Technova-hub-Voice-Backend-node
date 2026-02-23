import twilio from 'twilio';
import axios from 'axios';
import logger from '../utils/logger.js';
import pythonTTSService from './pythonTTSService.js';
import ivrWorkflowEngine from './ivrWorkflowEngine.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Execution Engine responsible for generating TwiML for specific node types
 * and handling node-specific business logic.
 */
class IVRExecutionEngine {

  /**
   * Execute a node and return TwiML
   * @param {Object} node - The node configuration
   * @param {Object} context - Execution context (variables, etc.)
   * @param {Object} workflowConfig - Full workflow config (nodes, edges, settings)
   * @param {String} callSid - Twilio Call SID
   * @returns {Promise<String>} TwiML string
   */
  async executeNode(node, context, workflowConfig, callSid) {
    const response = new VoiceResponse();
    const settings = workflowConfig.settings || {};
    const { nodes, edges } = workflowConfig;

    try {
      switch (node.type) {
        // Phone & Interaction Nodes
        case 'greeting':
          return await this._handleGreeting(response, node, edges, settings);
        case 'input':
          return await this._handleInput(response, node, workflowConfig, context);
        case 'transfer':
          return await this._handleTransfer(response, node, context);
        case 'voicemail':
          return await this._handleVoicemail(response, node, workflowConfig);
        case 'repeat':
          return await this._handleRepeat(response, node, workflowConfig, context, callSid);
        case 'queue':
          return await this._handleQueue(response, node);
        case 'end':
          return await this._handleEnd(response, node);

        // Logic & Data Nodes
        case 'condition':
        case 'conditional': // Support both names
          return await this._handleCondition(response, node, context, workflowConfig);
        case 'set_variable':
          return await this._handleSetVariable(response, node, context, workflowConfig, callSid);
        case 'api_call':
          return await this._handleApiCall(response, node, context, workflowConfig, callSid);

        // Communication Nodes
        case 'sms':
          return await this._handleSms(response, node, context, workflowConfig, callSid);
        case 'ai_assistant':
          return await this._handleAiAssistant(response, node, context, workflowConfig);

        // Industry Service Nodes (delegated)
        case 'audio':
          return await this._handleAudio(response, node, workflowConfig, context);
        default:
          logger.warn(`Unknown node type: ${node.type}`);
          response.say('An error occurred. Unknown step.');
          response.hangup();
          return response.toString();
      }
    } catch (error) {
      logger.error(`Error executing node ${node.id} (${node.type}):`, error);
      response.say('An error occurred while processing your request.');
      response.hangup();
      return response.toString();
    }
  }

  // ==========================================
  // HANDLER METHODS
  // ==========================================

  async _handleGreeting(response, node, edges, settings) {
    const { text, voice, language, audioUrl } = this._getMergedSettings(node, settings);

    if (audioUrl) {
      response.play(audioUrl);
    } else {
      response.say({ voice, language }, text || 'Hello.');
    }

    // Auto-transition to next node
    this._appendNextStep(response, node.id, edges, settings.workflowId);
    return response.toString();
  }

  async _handleInput(response, node, config, context = {}) {
    const { data } = node;
    const settings = config.settings || {};
    const { voice, language } = this._getMergedSettings(node, settings);
    const attemptCount = context.nodeAttempts?.[node.id] || 0;

    if (attemptCount >= 1) {
      const retryMessage = data.invalidInputMessage || settings.invalidInputMessage || 'Invalid input. Please try again.';
      response.say({ voice, language }, retryMessage);
    }

    const promptText = data.messageText || data.text || data.label || 'Please select an option.';

    const gather = response.gather({
      numDigits: data.numDigits || 1,
      timeout: data.timeout || settings.timeout || 10,
      action: `/ivr/handle-input?workflowId=${config._id}&currentNodeId=${node.id}`,
      method: 'POST'
    });

    if (data.audioUrl) {
      gather.play(data.audioUrl);
    } else {
      gather.say({ voice, language }, promptText);
    }

    // Loop audio if no input? (Optional enhancement)

    return response.toString();
  }

  async _handleTransfer(response, node, context) {
    const { data } = node;
    let destination = data.destination || data.transferNumber;

    // Resolve variable if destination contains one
    if (destination && destination.includes('{{')) {
      // Basic variable replacement would go here
      // destination = this._resolveVariables(destination, context);
    }

    if (data.text) {
      response.say(data.text);
    }

    if (!destination) {
      response.say('We are unable to transfer your call right now.');
      response.hangup();
      return response.toString();
    }

    response.dial({
      callerId: data.callerId || context?.twilioPhoneNumber || undefined,
      timeout: data.timeout || 30
    }, destination);

    return response.toString();
  }

  async _handleVoicemail(response, node, config) {
    const { data } = node;
    const settings = config.settings || {};
    const { voice, language } = this._getMergedSettings(node, settings);

    if (data.text) {
      response.say({ voice, language }, data.text);
    }

    response.record({
      action: `/ivr/next-step?workflowId=${config._id}&currentNodeId=${node.id}&status=recorded`, // Simplified callback
      maxLength: data.maxLength || 60,
      playBeep: true,
      transcribe: data.transcribe || false
    });

    return response.toString();
  }

  async _handleQueue(response, node) {
    const { data } = node;
    const queueName = data.queueName || 'General';

    response.enqueue({
      workflowSid: data.workflowSid // Optional Twilio TaskRouter Workflow SID
    }, queueName);

    return response.toString();
  }

  async _handleEnd(response, node) {
    const { data } = node;
    if (data.text || data.message) {
      const endMessage = data.text || data.message;
      response.say(endMessage);
    }
    response.hangup();
    return response.toString();
  }

  async _handleCondition(response, node, context, config) {
    const { data } = node;
    const { variable, operator, value } = data;
    const { edges } = config;

    // Fetch actual value from context variables
    const actualValue = context.variables ? context.variables[variable] : undefined;
    let isMatch = false;

    // Evaluate condition
    switch (operator) {
      case 'equals': isMatch = (actualValue == value); break;
      case 'not_equals': isMatch = (actualValue != value); break;
      case 'contains': isMatch = String(actualValue).includes(value); break;
      case 'greater_than': isMatch = Number(actualValue) > Number(value); break;
      case 'less_than': isMatch = Number(actualValue) < Number(value); break;
      case 'exists': isMatch = (actualValue !== undefined && actualValue !== null); break;
      default: isMatch = false;
    }

    logger.info(`Condition Evaluation: [${variable}](${actualValue}) ${operator} [${value}] = ${isMatch}`);

    // Find the correct edge based on result
    const targetHandle = isMatch ? 'true' : 'false';
    const edge = edges.find(e => e.source === node.id && e.sourceHandle === targetHandle);

    if (edge) {
      response.redirect(`/ivr/next-step?workflowId=${config._id}&currentNodeId=${edge.target}`);
    } else {
      // Fallback if no edge defined
      logger.warn(`No edge defined for condition result ${targetHandle} at node ${node.id}`);
      response.hangup();
    }

    return response.toString();
  }

  async _handleSetVariable(response, node, context, config, callSid) {
    const { data } = node;
    const { variable, value } = data; // Value can be static or another {{variable}}

    // Update variable in WorkflowEngine state
    if (variable && value && callSid) {
      ivrWorkflowEngine.setVariable(callSid, variable, value);
    }

    // Immediately move to next node
    this._appendNextStep(response, node.id, config.edges, config._id);
    return response.toString();
  }

  async _handleApiCall(response, node, context, config, callSid) {
    const { data } = node;
    const { url, method, headers, body, outputVariable } = data;

    // Move to next step immediately via redirect?
    // API calls are blocking if we want the result.
    // Since we are in TwiML generation, we can't easily wait for async API calls 
    // without holding the line silence.

    // APPROACH: Use TwiML <Redirect> to a helper endpoint that executes API 
    // and THEN redirects back to next step.
    // OR: Execute here (since we are async) and assume it's fast enough (< 2-3 sec).

    try {
      logger.info(`Executing API Call: ${method} ${url}`);
      const result = await axios({
        method: method || 'GET',
        url,
        headers: headers || {},
        data: body || {}
      });

      // Store result in variable if requested
      if (outputVariable && callSid) {
        // Store simplified result (status, data)
        const safeData = typeof result.data === 'object' ? JSON.stringify(result.data) : String(result.data);
        ivrWorkflowEngine.setVariable(callSid, `${outputVariable}.status`, result.status);
        ivrWorkflowEngine.setVariable(callSid, `${outputVariable}.data`, safeData);
      }

      // Success Path
      this._appendNextStep(response, node.id, config.edges, config._id, 'success');

    } catch (error) {
      logger.error('API Call Failed:', error.message);
      // Error Path
      this._appendNextStep(response, node.id, config.edges, config._id, 'error');
    }

    return response.toString();
  }

  async _handleSms(response, node, context, config, callSid) {
    const { data } = node;
    const { message, to } = data;

    // In a real TwiML flow, we can use <Sms> TwiML if we want to send during the call
    // OR use the REST API. <Sms> sends to the caller's number by default or specified 'to'.

    // Using TwiML <Sms> is easiest for simple cases
    if (message) {
      response.sms(message, {
        to: to || context.callerNumber
      });
    }

    this._appendNextStep(response, node.id, config.edges, config._id);
    return response.toString();
  }

  async _handleAiAssistant(response, node, context, config) {
    const { data } = node;
    // Twilio <Connect><Stream> or <Connect><VirtualAgent>
    // Here's a placeholder for streaming to a WebSocket URL (e.g., for AI processing)

    if (data.streamUrl) {
      const connect = response.connect();
      connect.stream({
        url: data.streamUrl
      });
    } else {
      response.say('AI Assistant configuration missing.');
    }

    // AI nodes usually handle conversation until completion or transfer
    return response.toString();
  }

  async _handleAudio(response, node, config, context = {}) {
    const { data } = node;
    const settings = config.settings || {};
    const { voice, language } = this._getMergedSettings(node, settings);
    const textToPlay = data.messageText || data.text || 'Playing audio.';

    // Handle After Playback logic
    if (data.afterPlayback === 'wait') {
      // Configuration for waiting (Gather)
      const gather = response.gather({
        numDigits: 1, // Usually just to catch any key to move forward or specific keys
        timeout: data.timeoutSeconds || settings.timeout || 10,
        action: `/ivr/handle-input?workflowId=${config._id}&currentNodeId=${node.id}`,
        method: 'POST'
      });
      if (data.mode === 'upload' && data.audioUrl) {
        gather.play(data.audioUrl);
      } else {
        gather.say({ voice, language }, textToPlay);
      }
      // Gather is non-blocking in TwiML, it will repeat if no input
      // If we want to move to next node ON TIMEOUT after wait, we need to handle it in handleUserInput
    } else {
      // Handle Playback mode (TTS vs Upload)
      if (data.mode === 'upload' && data.audioUrl) {
        response.play(data.audioUrl);
      } else {
        response.say({ voice, language }, textToPlay);
      }
      // Default: 'next' mode or null - Auto-transition
      this._appendNextStep(response, node.id, config.edges, config._id);
    }

    return response.toString();
  }

  async _handleIndustryService(response, node, config) {
    const { edges } = config;
    // Generic redirect to the controller's service processor
    response.say('Processing service request...');
    response.redirect(`/ivr/process-service?workflowId=${config._id}&nodeId=${node.id}`);
    return response.toString();
  }

  async _handleRepeat(response, node, config, context, callSid) {
    const maxRepeats = node.data?.maxRepeats || node.data?.max_repeats || 3;
    const repeatKey = `repeat_${node.id}`;
    let repeatCount = 0;

    if (callSid) {
      const currentCount = ivrWorkflowEngine.getVariable(callSid, repeatKey);
      repeatCount = Number.isFinite(currentCount) ? currentCount : 0;
      ivrWorkflowEngine.setVariable(callSid, repeatKey, repeatCount + 1);
    }

    if (repeatCount >= maxRepeats) {
      if (node.data?.fallbackNodeId) {
        response.redirect(`/ivr/next-step?workflowId=${config._id}&currentNodeId=${node.data.fallbackNodeId}`);
        return response.toString();
      }
      this._appendNextStep(response, node.id, config.edges, config._id, 'fallback');
      return response.toString();
    }

    const lastNodeId = context?.lastNodeId;
    if (node.data?.replayLastPrompt !== false && lastNodeId) {
      response.redirect(`/ivr/next-step?workflowId=${config._id}&currentNodeId=${lastNodeId}`);
      return response.toString();
    }

    response.say('Repeating.');
    this._appendNextStep(response, node.id, config.edges, config._id);
    return response.toString();
  }

  // ==========================================
  // HELPERS
  // ==========================================

  _getMergedSettings(node, globalSettings) {
    return {
      voice: this._normalizeTwilioVoice(node.data?.voice || globalSettings.voice || globalSettings.voiceId),
      language: node.data?.language || globalSettings.language || 'en-GB',
      text: node.data?.messageText || node.data?.text,
      audioUrl: node.data?.audioUrl
    };
  }

  _normalizeTwilioVoice(voice) {
    // Twilio <Say> does not support Edge neural voice IDs directly.
    if (!voice || /Neural$/i.test(voice)) return 'alice';
    return voice;
  }

  _appendNextStep(response, currentNodeId, edges, workflowId, handle = null) {
    // Find edge connected to source
    // If handle is provided (e.g. 'success', 'error', 'true', 'false'), match it
    const edge = edges.find(e =>
      e.source === currentNodeId &&
      (!handle || e.sourceHandle === handle)
    );

    if (edge) {
      response.redirect(`/ivr/next-step?workflowId=${workflowId}&currentNodeId=${edge.target}`);
    } else {
      // If no edge, maybe hangup or default end?
      // response.hangup();
    }
  }
}

export default new IVRExecutionEngine();
