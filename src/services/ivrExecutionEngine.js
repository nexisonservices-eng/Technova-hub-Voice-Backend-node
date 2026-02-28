import twilio from 'twilio';
import axios from 'axios';
import logger from '../utils/logger.js';
import ivrWorkflowEngine from './ivrWorkflowEngine.js';
import emailService from './emailService.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Execution Engine responsible for generating TwiML for specific node types
 * and handling node-specific business logic.
 */
class IVRExecutionEngine {
  _getNodeById(nodes = [], nodeId = '') {
    if (!nodeId) return null;
    return nodes.find((node) => node?.id === nodeId) || null;
  }

  _resolveAudioReference(nodes = [], nodeId = '') {
    const refNode = this._getNodeById(nodes, nodeId);
    if (!refNode) return null;

    const data = refNode.data || {};
    return {
      audioUrl: data.audioUrl || '',
      text: data.messageText || data.text || data.message || '',
      voice: data.voice || null,
      language: data.language || null
    };
  }

  _toBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n'].includes(normalized)) return false;
    }
    if (typeof value === 'number') return value !== 0;
    return fallback;
  }

  _toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  _evaluatePresetCondition(condition, context = {}, settings = {}, nodeData = {}) {
    const normalized = String(condition || '').trim().toLowerCase();
    const vars = context.variables || {};

    if (normalized === 'business_hours') {
      const startHour = this._toNumber(
        nodeData.businessStartHour ?? nodeData.business_start_hour ?? settings.businessStartHour,
        9
      );
      const endHour = this._toNumber(
        nodeData.businessEndHour ?? nodeData.business_end_hour ?? settings.businessEndHour,
        18
      );
      const timezone = String(
        nodeData.businessTimezone ?? nodeData.business_timezone ?? settings.businessTimezone ?? settings.timezone ?? ''
      ).trim();
      const allowedDaysRaw = nodeData.businessDays ?? nodeData.business_days ?? settings.businessDays;
      const dayNameMap = {
        sunday: 0, sun: 0,
        monday: 1, mon: 1,
        tuesday: 2, tue: 2, tues: 2,
        wednesday: 3, wed: 3,
        thursday: 4, thu: 4, thur: 4, thurs: 4,
        friday: 5, fri: 5,
        saturday: 6, sat: 6
      };
      const normalizeDay = (day) => {
        if (typeof day === 'number') return day >= 0 && day <= 6 ? day : -1;
        const str = String(day || '').trim().toLowerCase();
        if (str in dayNameMap) return dayNameMap[str];
        const n = this._toNumber(str, -1);
        return n >= 0 && n <= 6 ? n : -1;
      };
      const allowedDays = Array.isArray(allowedDaysRaw)
        ? new Set(allowedDaysRaw.map((day) => normalizeDay(day)).filter((day) => day >= 0 && day <= 6))
        : new Set([1, 2, 3, 4, 5]); // Mon-Fri
      const now = new Date();
      const localDate = timezone
        ? new Date(now.toLocaleString('en-US', { timeZone: timezone }))
        : now;
      const day = localDate.getDay();
      const hour = localDate.getHours();
      if (!allowedDays.has(day)) return false;
      return hour >= startHour && hour < endHour;
    }

    if (normalized === 'caller_id_known') {
      const callerVariable = String(
        nodeData.callerNumberVariable ??
        nodeData.caller_number_variable ??
        'callerNumber'
      ).trim() || 'callerNumber';
      const caller = String(context.callerNumber || vars[callerVariable] || vars.callerNumber || '').trim();
      if (!caller) return false;
      const unknownValuesRaw =
        nodeData.unknownCallerValues ??
        nodeData.unknown_caller_values ??
        ['unknown', 'anonymous', 'private', 'restricted', 'unavailable'];
      const unknownValues = new Set(
        (Array.isArray(unknownValuesRaw) ? unknownValuesRaw : String(unknownValuesRaw || '').split(','))
          .map((v) => String(v || '').trim().toLowerCase())
          .filter(Boolean)
      );
      return !unknownValues.has(caller.toLowerCase());
    }

    if (normalized === 'premium_customer') {
      const flagVariable = String(
        nodeData.premiumFlagVariable ??
        nodeData.premium_flag_variable ??
        'isPremium'
      ).trim() || 'isPremium';
      const tierVariable = String(
        nodeData.premiumTierVariable ??
        nodeData.premium_tier_variable ??
        'customerTier'
      ).trim() || 'customerTier';
      const segmentVariable = String(
        nodeData.premiumSegmentVariable ??
        nodeData.premium_segment_variable ??
        'segment'
      ).trim() || 'segment';
      const tierValuesRaw =
        nodeData.premiumTiers ??
        nodeData.premium_tiers ??
        ['premium', 'vip'];
      const premiumTierValues = new Set(
        (Array.isArray(tierValuesRaw) ? tierValuesRaw : String(tierValuesRaw || '').split(','))
          .map((v) => String(v || '').trim().toLowerCase())
          .filter(Boolean)
      );
      const tier = String(vars[tierVariable] || '').trim().toLowerCase();
      const segment = String(vars[segmentVariable] || '').trim().toLowerCase();
      const flag = this._toBoolean(vars[flagVariable], false);
      return flag || premiumTierValues.has(tier) || premiumTierValues.has(segment);
    }

    return false;
  }

  _resolveContactMethod(contactMethod = '') {
    const normalized = String(contactMethod || '').trim().toLowerCase();
    if (normalized === 'email') return { sms: false, email: true };
    if (normalized === 'both') return { sms: true, email: true };
    return { sms: true, email: false }; // default sms
  }


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
          return await this._handleEnd(response, node, workflowConfig, context);

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
    const nodes = Array.isArray(config.nodes) ? config.nodes : [];
    const pendingActionKey = `inputAction:${node.id}`;
    const pendingAction = context.variables?.[pendingActionKey];
    const attemptCount = context.nodeAttempts?.[node.id] || 0;

    if (pendingAction && typeof pendingAction === 'object') {
      const action = String(pendingAction.action || '').trim().toLowerCase();
      const destination = String(pendingAction.destination || '').trim();

      if (context.callSid) {
        ivrWorkflowEngine.setVariable(context.callSid, pendingActionKey, null);
      }

      if (action === 'transfer' && destination) {
        response.dial({
          callerId: data.callerId || context?.twilioPhoneNumber || undefined,
          timeout: data.transferTimeout || data.transfer_timeout || data.timeout || 30
        }, destination);
        return response.toString();
      }

      if (action === 'submenu' && destination) {
        response.redirect(`/ivr/next-step?workflowId=${config._id}&currentNodeId=${destination}`);
        return response.toString();
      }

      if (action === 'queue') {
        const queueName = destination || data.queueName || 'General';
        response.enqueue({
          workflowSid: data.workflowSid
        }, queueName);
        return response.toString();
      }

      if (action === 'voicemail') {
        response.record({
          action: `/ivr/next-step?workflowId=${config._id}&currentNodeId=${node.id}&status=recorded`,
          maxLength: data.maxLength || 60,
          playBeep: true,
          transcribe: this._toBoolean(data.transcribe, false)
        });
        return response.toString();
      }
    }

    if (attemptCount >= 1) {
      const lastReason = context.lastInputReasonByNode?.[node.id];
      const retryRefId = lastReason === 'timeout'
        ? (data.timeoutAudioNodeId || data.timeout_audio_node_id)
        : (data.invalidAudioNodeId || data.invalid_audio_node_id);
      const retryRef = this._resolveAudioReference(nodes, retryRefId);
      if (retryRef?.audioUrl) {
        response.play(retryRef.audioUrl);
      } else if (retryRef?.text) {
        response.say(
          { voice: this._normalizeTwilioVoice(retryRef.voice || voice), language: retryRef.language || language },
          retryRef.text
        );
      } else {
        const retryMessage = data.invalidInputMessage || settings.invalidInputMessage || 'Invalid input. Please try again.';
        response.say({ voice, language }, retryMessage);
      }
    }

    const promptText = data.messageText || data.text || data.label || 'Please select an option.';
    const promptRefId = data.promptAudioNodeId || data.prompt_audio_node_id;
    const promptRef = this._resolveAudioReference(nodes, promptRefId);

    const gather = response.gather({
      numDigits: data.numDigits || 1,
      timeout: data.timeoutSeconds || data.timeout || settings.timeout || 10,
      action: `/ivr/handle-input?workflowId=${config._id}&currentNodeId=${node.id}`,
      method: 'POST'
    });

    if (promptRef?.audioUrl) {
      gather.play(promptRef.audioUrl);
    } else if (promptRef?.text) {
      gather.say(
        { voice: this._normalizeTwilioVoice(promptRef.voice || voice), language: promptRef.language || language },
        promptRef.text
      );
    } else if (data.audioUrl) {
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
    const nodes = Array.isArray(config.nodes) ? config.nodes : [];

    const greetingRefId = data.greetingAudioNodeId || data.greeting_audio_node_id;
    const greetingRef = this._resolveAudioReference(nodes, greetingRefId);

    if (greetingRef?.audioUrl) {
      response.play(greetingRef.audioUrl);
    } else if (greetingRef?.text) {
      response.say(
        { voice: this._normalizeTwilioVoice(greetingRef.voice || voice), language: greetingRef.language || language },
        greetingRef.text
      );
    } else if (data.text) {
      response.say({ voice, language }, data.text);
    }

    const fallbackNodeId = String(data.fallbackNodeId || data.fallback_node_id || '').trim();
    const fallbackQuery = fallbackNodeId ? `&fallbackNodeId=${encodeURIComponent(fallbackNodeId)}` : '';
    response.record({
      action: `/ivr/next-step?workflowId=${config._id}&currentNodeId=${node.id}&status=recorded${fallbackQuery}`,
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

  async _handleEnd(response, node, config, context = {}) {
    const { data } = node;
    const settings = config?.settings || {};
    const { voice, language } = this._getMergedSettings(node, settings);
    const terminationType = (data.terminationType || data.reason || 'hangup').toString().toLowerCase();
    const callbackDelay = this._toNumber(data.callbackDelay || data.callback_delay, 15);
    const maxCallbackAttempts = this._toNumber(data.maxCallbackAttempts || data.max_callback_attempts, 3);
    const sendSurvey = this._toBoolean(data.sendSurvey || data.send_survey, false);
    const sendReceipt = this._toBoolean(data.sendReceipt || data.send_receipt, false);
    const logCall = this._toBoolean(data.logCall || data.log_data, false);
    const contactMethod = data.contactMethod || data.contact_method || 'sms';
    const { sms: sendSms, email: sendEmail } = this._resolveContactMethod(contactMethod);
    const callerNumber = context?.callerNumber || context?.variables?.callerNumber || '';
    const callerEmail = context?.variables?.callerEmail || context?.variables?.email || '';
    const isSmtpConfigured = Boolean(
      process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      process.env.SMTP_FROM
    );
    const actionNotes = [];

    if (data.text || data.message) {
      const endMessage = data.text || data.message;
      response.say({ voice, language }, endMessage);
    }

    if (terminationType === 'transfer') {
      const transferNumber = data.transferNumber || data.transfer_number;
      if (transferNumber) {
        response.dial({
          callerId: data.callerId || context?.twilioPhoneNumber || undefined,
          timeout: data.timeout || 30
        }, transferNumber);
        return response.toString();
      }
    }

    if (terminationType === 'voicemail') {
      response.record({
        action: `/ivr/next-step?workflowId=${config._id}&currentNodeId=${node.id}&status=recorded`,
        maxLength: data.maxLength || 60,
        playBeep: true,
        transcribe: this._toBoolean(data.transcribe, false)
      });
      return response.toString();
    }

    if (terminationType === 'callback') {
      if (context?.callSid) {
        ivrWorkflowEngine.setVariable(context.callSid, 'callback.requested', true);
        ivrWorkflowEngine.setVariable(context.callSid, 'callback.delay_minutes', callbackDelay);
        ivrWorkflowEngine.setVariable(context.callSid, 'callback.max_attempts', maxCallbackAttempts);
      }
      response.say(
        { voice, language },
        `We will call you back in approximately ${callbackDelay} minutes. Thank you for your patience.`
      );
    }

    if (logCall) {
      actionNotes.push('log_call');
      logger.info(`End node logCall enabled for ${context?.callSid || 'unknown_call'}`);
    }

    if (sendSurvey) {
      if (sendSms && callerNumber) {
        response.sms(
          'Thanks for contacting us. Please rate your experience: reply with a number from 1 to 5.',
          { to: callerNumber }
        );
        actionNotes.push('survey_sms');
      }
      if (sendEmail) {
        if (!isSmtpConfigured) {
          actionNotes.push('survey_email_smtp_not_configured');
          logger.warn(`Survey email skipped for ${context?.callSid || 'unknown_call'}: smtp_not_configured`);
        } else {
          const surveyEmailResult = await emailService.sendEmail({
            to: callerEmail,
            subject: 'Please rate your recent call',
            text: 'Thanks for contacting us. Please rate your experience from 1 to 5 by replying to this email.',
            metadata: {
              callSid: context?.callSid,
              event: 'survey_email'
            }
          });
          actionNotes.push(surveyEmailResult.success ? 'survey_email' : `survey_email_${surveyEmailResult.reason || 'failed'}`);
          if (!surveyEmailResult.success) {
            logger.warn(`Survey email was not sent for ${context?.callSid || 'unknown_call'}: ${surveyEmailResult.reason || 'unknown'}`);
          }
        }
      }
    }

    if (sendReceipt) {
      if (sendSms && callerNumber) {
        response.sms(
          'Your call has ended successfully. Thank you for choosing our service.',
          { to: callerNumber }
        );
        actionNotes.push('receipt_sms');
      }
      if (sendEmail) {
        if (!isSmtpConfigured) {
          actionNotes.push('receipt_email_smtp_not_configured');
          logger.warn(`Receipt email skipped for ${context?.callSid || 'unknown_call'}: smtp_not_configured`);
        } else {
          const receiptEmailResult = await emailService.sendEmail({
            to: callerEmail,
            subject: 'Your call receipt',
            text: 'Your call has ended successfully. Thank you for choosing our service.',
            metadata: {
              callSid: context?.callSid,
              event: 'receipt_email'
            }
          });
          actionNotes.push(receiptEmailResult.success ? 'receipt_email' : `receipt_email_${receiptEmailResult.reason || 'failed'}`);
          if (!receiptEmailResult.success) {
            logger.warn(`Receipt email was not sent for ${context?.callSid || 'unknown_call'}: ${receiptEmailResult.reason || 'unknown'}`);
          }
        }
      }
    }

    if (context?.callSid && actionNotes.length > 0) {
      ivrWorkflowEngine.setVariable(context.callSid, 'end.post_actions', actionNotes.join(','));
      ivrWorkflowEngine.setVariable(context.callSid, 'end.contact_method', String(contactMethod));
    }

    response.hangup();
    return response.toString();
  }

  async _handleCondition(response, node, context, config) {
    const { data } = node;
    const { variable, operator, value, condition, truePath, true_path, falsePath, false_path } = data;
    const { edges } = config;
    const settings = config.settings || {};

    let isMatch = false;
    const hasCustomExpression = Boolean(variable && operator);

    if (hasCustomExpression) {
      const actualValue = context.variables ? context.variables[variable] : undefined;
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
    } else {
      isMatch = this._evaluatePresetCondition(condition, context, settings, data);
      logger.info(`Preset condition evaluation: [${condition}] => ${isMatch}`);
    }

    // Find the correct edge based on result
    const targetHandle = isMatch ? 'true' : 'false';
    const edge = edges.find(e => e.source === node.id && e.sourceHandle === targetHandle);
    const directNodeId = isMatch ? (truePath || true_path) : (falsePath || false_path);

    if (edge) {
      response.redirect(`/ivr/next-step?workflowId=${config._id}&currentNodeId=${edge.target}`);
    } else if (directNodeId) {
      response.redirect(`/ivr/next-step?workflowId=${config._id}&currentNodeId=${directNodeId}`);
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
    logger.warn(`AI assistant streaming is disabled for node ${node?.id || 'unknown_node'}.`);
    response.say('AI assistant routing is currently disabled.');
    this._appendNextStep(response, node.id, config.edges, config._id);
    return response.toString();
  }

  async _handleAudio(response, node, config, context = {}) {
    const { data } = node;
    const settings = config.settings || {};
    const nodes = Array.isArray(config.nodes) ? config.nodes : [];
    const { voice, language } = this._getMergedSettings(node, settings);
    const textToPlay = data.messageText || data.text || 'Playing audio.';
    const fallbackRefId = data.fallbackAudioNodeId;
    const fallbackRef = this._resolveAudioReference(nodes, fallbackRefId);
    const hasUploadAudio = Boolean(data.mode === 'upload' && data.audioUrl);
    const playFallback = () => {
      if (fallbackRef?.audioUrl) {
        response.play(fallbackRef.audioUrl);
        return true;
      }
      if (fallbackRef?.text) {
        response.say(
          { voice: this._normalizeTwilioVoice(fallbackRef.voice || voice), language: fallbackRef.language || language },
          fallbackRef.text
        );
        return true;
      }
      return false;
    };

    // Handle After Playback logic
    if (data.afterPlayback === 'wait') {
      // Configuration for waiting (Gather)
      const gather = response.gather({
        numDigits: data.numDigits || 1,
        timeout: data.timeoutSeconds || settings.timeout || 10,
        action: `/ivr/handle-input?workflowId=${config._id}&currentNodeId=${node.id}`,
        method: 'POST'
      });
      if (hasUploadAudio) {
        gather.play(data.audioUrl);
      } else if (data.mode === 'upload' && !hasUploadAudio && fallbackRef?.audioUrl) {
        gather.play(fallbackRef.audioUrl);
      } else if (data.mode === 'upload' && !hasUploadAudio && fallbackRef?.text) {
        gather.say(
          { voice: this._normalizeTwilioVoice(fallbackRef.voice || voice), language: fallbackRef.language || language },
          fallbackRef.text
        );
      } else {
        gather.say({ voice, language }, textToPlay);
      }
      // Gather is non-blocking in TwiML, it will repeat if no input
      // If we want to move to next node ON TIMEOUT after wait, we need to handle it in handleUserInput
    } else {
      // Handle Playback mode (TTS vs Upload)
      if (hasUploadAudio) {
        response.play(data.audioUrl);
      } else if (data.mode === 'upload' && !playFallback()) {
        response.say({ voice, language }, textToPlay);
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
