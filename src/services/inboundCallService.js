import twilio from 'twilio';
import logger from '../utils/logger.js';
import telephonyService from './telephonyService.js';
import callStateService from './callStateService.js';
import callbackService from './callbackService.js';
import aiAssistantService from './aiAssistantService.js';
import Call from '../models/call.js';
import User from '../models/user.js';
import { emitQueueUpdate, emitIVRUpdate } from '../sockets/unifiedSocket.js';
import callDetailsController from '../controllers/callDetailsController.js';


class InboundCallService {
  constructor() {
    this.callQueues = new Map(); // Queue management
    this.ivrMenus = new Map(); // IVR configurations
    this.routingRules = new Map(); // Business routing rules
    this.activeAgents = new Map(); // Available agents

    this.initializeDefaultIVR();
    this.initializeRoutingRules();

    logger.info('âœ“ Inbound Call Service Initialized');
  }

  /* =========================
     Initialize Default IVR Menu
  ========================== */
  initializeDefaultIVR() {
    this.ivrMenus.set('main', {
      greeting: 'Welcome to our AI assistant. Please choose from the following options:',
      menu: [
        {
          digit: '1',
          text: 'For sales and support, press 1',
          action: 'route_to_sales',
          next: 'sales'
        },
        {
          digit: '2',
          text: 'For technical support, press 2',
          action: 'route_to_tech',
          next: 'tech'
        },
        {
          digit: '3',
          text: 'For billing inquiries, press 3',
          action: 'route_to_billing',
          next: 'billing'
        },
        {
          digit: '4',
          text: 'To speak with our AI assistant, press 4',
          action: 'route_to_ai',
          next: null
        },
        {
          digit: '0',
          text: 'To repeat these options, press 0',
          action: 'repeat',
          next: 'main'
        }
      ],
      timeout: 10, // seconds
      maxAttempts: 3,
      invalidInputMessage: 'Invalid selection. Please try again.'
    });

    // Specialized IVR menus
    this.ivrMenus.set('sales', {
      greeting: 'Sales department. How can we help you today?',
      menu: [
        {
          digit: '1',
          text: 'Product information, press 1',
          action: 'route_to_ai',
          context: 'product_info'
        },
        {
          digit: '2',
          text: 'Pricing and plans, press 2',
          action: 'route_to_ai',
          context: 'pricing'
        },
        {
          digit: '3',
          text: 'Speak to a representative, press 3',
          action: 'queue_for_agent',
          queue: 'sales'
        }
      ],
      timeout: 8,
      maxAttempts: 3
    });
  }

  /* =========================
     Initialize Routing Rules
  ========================== */
  initializeRoutingRules() {
    this.routingRules.set('default', {
      priority: 1,
      conditions: [],
      actions: ['ivr_main']
    });

    this.routingRules.set('vip_customer', {
      priority: 10,
      conditions: [
        { field: 'user.vip', operator: 'equals', value: true }
      ],
      actions: ['priority_queue', 'route_to_ai']
    });

    this.routingRules.set('business_hours', {
      priority: 5,
      conditions: [
        { field: 'time', operator: 'in_hours', value: { start: 9, end: 17 } }
      ],
      actions: ['ivr_main']
    });

    this.routingRules.set('after_hours', {
      priority: 5,
      conditions: [
        { field: 'time', operator: 'out_of_hours', value: { start: 9, end: 17 } }
      ],
      actions: ['voicemail', 'callback_option']
    });
  }

  /* =========================
     Process Incoming Call with AI Fallback
  ========================== */
  async processIncomingCall(callData) {
    try {
      const { CallSid, From, To } = callData;

      logger.info(`ðŸ“ž Processing inbound call: ${CallSid} from ${From}`);

      // Create call record
      const { call, user } = await callStateService.createCall({
        callSid: CallSid,
        phoneNumber: From,
        direction: 'inbound',
        provider: 'twilio'
      });

      // Notify call details controller of new call
      await callDetailsController.notifyCallCreated({
        callSid: CallSid,
        phoneNumber: From,
        to: To,
        direction: 'inbound',
        status: 'initiated',
        provider: 'twilio',
        timestamp: new Date()
      }, 'inbound');

      // Determine routing based on rules

      const routing = await this.determineRouting(call, user);

      // Check if AI fallback should be triggered
      const shouldFallbackToAI = await this.shouldTriggerAIFallback(routing, call, user);

      let result;
      if (shouldFallbackToAI.trigger) {
        // Trigger AI fallback
        result = await this.handleAIFallbackRouting(CallSid, shouldFallbackToAI.reason, callData);
      } else {
        // Execute normal routing actions
        result = await this.executeRouting(CallSid, routing, callData);
      }

      return {
        success: true,
        callSid: CallSid,
        routing: shouldFallbackToAI.trigger ? 'ai_fallback' : routing.name,
        fallbackReason: shouldFallbackToAI.reason,
        actions: result.actions,
        twiml: result.twiml
      };

    } catch (error) {
      logger.error('âŒ Failed to process inbound call:', error);
      throw error;
    }
  }

  /**
   * ==========================================
   * Determine if AI Fallback Should Be Triggered
   * ==========================================
   */
  async shouldTriggerAIFallback(routing, call, user) {
    try {
      // Check business hours
      if (!this.isBusinessHours() && routing.name !== 'after_hours') {
        return { trigger: true, reason: 'after_hours' };
      }

      // Check agent availability
      const availableAgents = this.activeAgents.size;
      if (availableAgents === 0 && routing.actions.includes('queue_for_agent')) {
        return { trigger: true, reason: 'no_agent_available' };
      }

      // Check queue length
      const totalQueueLength = Array.from(this.callQueues.values())
        .reduce((total, queue) => total + queue.length, 0);

      if (totalQueueLength > 10) { // Configurable threshold
        return { trigger: true, reason: 'high_queue_volume' };
      }

      // Check for VIP customers (might want human agent)
      if (user?.vip && routing.name === 'default') {
        // Don't trigger AI for VIP customers unless specifically configured
        return { trigger: false };
      }

      // Check for emergency keywords
      const emergencyKeywords = ['emergency', 'urgent', 'help', 'danger'];
      if (call.notes && emergencyKeywords.some(keyword =>
        call.notes.toLowerCase().includes(keyword))) {
        return { trigger: true, reason: 'emergency_routing' };
      }

      return { trigger: false };

    } catch (error) {
      logger.error('Error checking AI fallback conditions:', error);
      return { trigger: false };
    }
  }

  /**
   * ==========================================
   * Handle AI Fallback Routing
   * ==========================================
   */
  async handleAIFallbackRouting(callSid, fallbackReason, callData) {
    try {
      logger.info(`ðŸ¤– Routing ${callSid} to AI fallback: ${fallbackReason}`);

      // Initialize AI assistant
      await aiAssistantService.handleAIFallback(callSid, fallbackReason, {
        phoneNumber: callData.From,
        to: callData.To,
        businessHours: this.isBusinessHours(),
        availableAgents: this.activeAgents.size
      });

      // Generate TwiML for AI connection
      const result = this.routeToAI(callSid, {
        fallbackReason,
        context: 'ai_fallback'
      });

      return {
        actions: ['ai_fallback'],
        twiml: result.twiml
      };

    } catch (error) {
      logger.error(`AI fallback routing failed for ${callSid}:`, error);

      // Fallback to basic IVR if AI fails
      return this.generateIVRTwiML('main', callSid);
    }
  }

  /* =========================
     Determine Call Routing
  ========================== */
  async determineRouting(call, user) {
    const applicableRules = [];

    for (const [name, rule] of this.routingRules) {
      if (await this.evaluateConditions(rule.conditions, call, user)) {
        applicableRules.push({ name, ...rule });
      }
    }

    // Sort by priority and take highest
    applicableRules.sort((a, b) => b.priority - a.priority);

    const selectedRule = applicableRules[0] || this.routingRules.get('default');

    logger.info(`ðŸ“ Routing call ${call.callSid} to: ${selectedRule.name}`);

    return selectedRule;
  }

  /* =========================
     Evaluate Routing Conditions
  ========================== */
  async evaluateConditions(conditions, call, user) {
    if (conditions.length === 0) return true;

    for (const condition of conditions) {
      const result = await this.evaluateCondition(condition, call, user);
      if (!result) return false;
    }

    return true;
  }

  async evaluateCondition(condition, call, user) {
    const { field, operator, value } = condition;

    switch (field) {
      case 'user.vip':
        return user?.vip === value;

      case 'time':
        const now = new Date();
        const currentHour = now.getHours();

        if (operator === 'in_hours') {
          return currentHour >= value.start && currentHour < value.end;
        } else if (operator === 'out_of_hours') {
          return currentHour < value.start || currentHour >= value.end;
        }
        break;

      case 'phone_number':
        return call.phoneNumber.includes(value);

      default:
        logger.warn(`Unknown condition field: ${field}`);
        return true;
    }

    return false;
  }

  /* =========================
     Execute Routing Actions
  ========================== */
  async executeRouting(callSid, routing, callData) {
    const actions = [];
    let twiml = '';

    for (const action of routing.actions) {
      const result = await this.executeAction(action, callSid, callData);
      actions.push(action);

      if (result.twiml) {
        twiml = result.twiml;
      }
    }

    return { actions, twiml };
  }

  /* =========================
     Execute Individual Action
  ========================== */
  async executeAction(action, callSid, callData) {
    switch (action) {
      case 'ivr_main':
        return this.generateIVRTwiML('main', callSid);

      case 'route_to_ai':
        return this.routeToAI(callSid, callData);

      case 'priority_queue':
        return this.addToPriorityQueue(callSid);

      case 'voicemail':
        return this.routeToVoicemail(callSid);

      case 'callback_option':
        return this.offerCallback(callSid, callData);

      default:
        logger.warn(`Unknown action: ${action}`);
        return { twiml: '' };
    }
  }

  /* =========================
     Generate IVR TwiML
  ========================== */
  generateIVRTwiML(menuName, callSid) {
    const menu = this.ivrMenus.get(menuName);
    if (!menu) {
      throw new Error(`IVR menu not found: ${menuName}`);
    }

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    // Greeting
    response.say({
      voice: 'alice',
      language: 'en-US'
    }, menu.greeting);

    // Gather user input
    const gather = response.gather({
      numDigits: 1,
      timeout: menu.timeout,
      action: `/webhook/ivr/selection/${callSid}`,
      method: 'POST'
    });

    // Menu options
    menu.menu.forEach(option => {
      gather.say({
        voice: 'alice',
        language: 'en-US'
      }, option.text);
    });

    // Handle timeout/no input
    response.say({
      voice: 'alice',
      language: 'en-US'
    }, 'No input received. Connecting to AI assistant.');

    // Fallback to AI
    const connect = response.connect();
    connect.stream({
      url: `wss://${process.env.BASE_URL?.replace('https://', '').replace('http://', '')}/media/${callSid}`,
      track: 'both_tracks'
    });

    // Store IVR state
    callStateService.updateCallState(callSid, {
      ivrState: {
        currentMenu: menuName,
        attempts: 0,
        maxAttempts: menu.maxAttempts
      }
    });

    return { twiml: response.toString() };
  }

  /* =========================
     Route to AI Assistant
  ========================== */
  routeToAI(callSid, callData) {
    const websocketUrl = `wss://${process.env.BASE_URL?.replace('https://', '').replace('http://', '')}/media/${callSid}`;

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say({
      voice: 'alice',
      language: 'en-US'
    }, 'Connecting you to our AI assistant.');

    const connect = response.connect();
    connect.stream({
      url: websocketUrl,
      track: 'both_tracks'
    });

    return { twiml: response.toString() };
  }

  /* =========================
     Handle IVR Selection with AI Fallback
  ========================== */
  async handleIVRSelection(callSid, digits) {
    try {
      const state = callStateService.getCallState(callSid);
      if (!state || !state.ivrState) {
        throw new Error('IVR state not found');
      }

      const { currentMenu, attempts, maxAttempts } = state.ivrState;
      const menu = this.ivrMenus.get(currentMenu);

      if (!menu) {
        throw new Error(`Menu not found: ${currentMenu}`);
      }

      // Find matching option
      const option = menu.menu.find(opt => opt.digit === digits);

      if (!option) {
        // Invalid input
        if (attempts >= maxAttempts) {
          // Max attempts reached, route to AI fallback
          logger.warn(`[${callSid}] Max IVR attempts reached, routing to AI fallback`);
          return await this.handleAIFallbackRouting(callSid, 'invalid_input_max_attempts', {
            From: state.call?.phoneNumber,
            To: state.call?.to
          });
        } else {
          // Retry
          callStateService.updateCallState(callSid, {
            ivrState: { ...state.ivrState, attempts: attempts + 1 }
          });

          const VoiceResponse = twilio.twiml.VoiceResponse;
          const response = new VoiceResponse();

          response.say({
            voice: 'alice',
            language: 'en-US'
          }, menu.invalidInputMessage);

          // Redirect back to same menu
          response.redirect({
            method: 'POST'
          }, `/webhook/call/incoming`);

          return { twiml: response.toString() };
        }
      }

      // Execute action
      return await this.executeIVRAction(option, callSid);

    } catch (error) {
      logger.error(`[${callSid}] IVR selection error:`, error);
      // Fallback to AI on error
      return await this.handleAIFallbackRouting(callSid, 'ivR_error', {
        From: callStateService.getCallState(callSid)?.call?.phoneNumber,
        To: callStateService.getCallState(callSid)?.call?.to
      });
    }
  }

  /* =========================
     Execute IVR Action
  ========================== */
  async executeIVRAction(option, callSid) {
    switch (option.action) {
      case 'route_to_ai':
        return this.routeToAI(callSid, { context: option.context });

      case 'queue_for_agent':
        return this.addToQueue(callSid, option.queue);

      case 'route_to_sales':
      case 'route_to_tech':
      case 'route_to_billing':
        return this.routeToDepartment(option.action.split('_')[2], callSid);

      case 'repeat':
        return this.generateIVRTwiML(option.next, callSid);

      case 'start_booking':
        return bookingFlowService.startFlow(callSid);

      default:
        logger.warn(`Unknown IVR action: ${option.action}`);
        return this.routeToAI(callSid);
    }
  }

  /* =========================
     Enhanced Queue Management
  ========================== */
  addToQueue(callSid, queueName, priority = 'normal') {
    if (!this.callQueues.has(queueName)) {
      this.callQueues.set(queueName, []);
    }

    const queue = this.callQueues.get(queueName);
    const position = queue.length + 1;

    const queueEntry = {
      callSid,
      queuedAt: new Date(),
      position,
      priority,
      estimatedWaitTime: this.calculateEstimatedWaitTime(queueName, position)
    };

    // Insert based on priority (high priority first)
    if (priority === 'high' || priority === 'urgent') {
      // Find insertion point for high priority
      let insertIndex = 0;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].priority !== 'urgent' && queue[i].priority !== 'high') {
          insertIndex = i;
          break;
        }
        insertIndex = i + 1;
      }
      queue.splice(insertIndex, 0, queueEntry);

      // Update positions for all calls after insertion
      for (let i = insertIndex + 1; i < queue.length; i++) {
        queue[i].position = i + 1;
      }
    } else {
      queue.push(queueEntry);
    }

    logger.info(`[${callSid}] Added to ${queueName} queue at position ${position} (${priority} priority)`);

    // Emit real-time queue update
    emitQueueUpdate({
      queueName,
      action: 'joined',
      callSid,
      position: queueEntry.position,
      priority,
      estimatedWaitTime: queueEntry.estimatedWaitTime,
      queueLength: queue.length
    });

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say({
      voice: 'alice',
      language: 'en-US'
    }, `You are ${this.getPositionText(queueEntry.position)} in the queue. Estimated wait time is ${Math.ceil(queueEntry.estimatedWaitTime / 60)} minutes.`);

    response.play({
      loop: 10
    }, 'https://com.twilio.music.classical.s3.amazonaws.com/MLOCKP_01.mp3');

    return { twiml: response.toString() };
  }

  calculateEstimatedWaitTime(queueName, position) {
    const queue = this.callQueues.get(queueName) || [];
    if (queue.length === 0) return 0;

    // Average call duration (can be made configurable)
    const avgCallDuration = 300; // 5 minutes in seconds

    // Calculate based on average agent handling time
    return position * avgCallDuration;
  }

  removeFromQueue(callSid, queueName) {
    const queue = this.callQueues.get(queueName);
    if (!queue) return false;

    const index = queue.findIndex(entry => entry.callSid === callSid);
    if (index === -1) return false;

    queue.splice(index, 1);

    // Update positions for remaining calls
    for (let i = index; i < queue.length; i++) {
      queue[i].position = i + 1;
      queue[i].estimatedWaitTime = this.calculateEstimatedWaitTime(queueName, queue[i].position);
    }

    logger.info(`[${callSid}] Removed from ${queueName} queue`);

    // Emit queue update
    emitQueueUpdate({
      queueName,
      action: 'left',
      callSid,
      queueLength: queue.length
    });

    return true;
  }

  updateQueuePosition(callSid, queueName) {
    const queue = this.callQueues.get(queueName);
    if (!queue) return null;

    const entry = queue.find(entry => entry.callSid === callSid);
    if (!entry) return null;

    entry.estimatedWaitTime = this.calculateEstimatedWaitTime(queueName, entry.position);

    // Emit position update
    emitQueueUpdate({
      queueName,
      action: 'position_update',
      callSid,
      position: entry.position,
      estimatedWaitTime: entry.estimatedWaitTime
    });

    return entry;
  }

  /* =========================
     Enhanced Callback Integration
  ========================== */
  async scheduleCallback(callSid, phoneNumber, priority = 'normal', scheduledTime = null) {
    try {
      const state = callStateService.getCallState(callSid);
      if (!state) {
        throw new Error('Call state not found');
      }

      const callback = await callbackService.scheduleCallback({
        originalCallSid: callSid,
        phoneNumber: phoneNumber,
        requestedBy: state.user?._id || 'system',
        priority: priority,
        scheduledFor: scheduledTime || new Date(Date.now() + 15 * 60 * 1000), // 15 minutes default
        context: {
          originalCallContext: state.routing || 'unknown',
          userPreferences: state.user?.metadata || {}
        },
        notes: `Callback requested during ${state.routing || 'inbound'} call`
      });

      logger.info(`[${callSid}] Callback scheduled: ${callback.callSid} for ${phoneNumber}`);

      return callback;
    } catch (error) {
      logger.error(`[${callSid}] Failed to schedule callback:`, error);
      throw error;
    }
  }

  async handleCallbackRequest(callSid, phoneNumber, priority = 'normal') {
    try {
      // Schedule the callback
      const callback = await this.scheduleCallback(callSid, phoneNumber, priority);

      // Update call state with callback request
      await callStateService.updateCallState(callSid, {
        callback: {
          requested: true,
          callbackId: callback._id,
          scheduledFor: callback.scheduledFor,
          priority
        }
      });

      return callback;
    } catch (error) {
      logger.error(`[${callSid}] Callback request failed:`, error);
      throw error;
    }
  }

  /* =========================
     Enhanced IVR with Callback Options
  ========================== */
  generateCallbackIVRTwiML(callSid) {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say({
      voice: 'alice',
      language: 'en-US'
    }, 'All our agents are currently busy. Press 1 to schedule a callback, press 2 to leave a voicemail, or press 3 to return to the main menu.');

    const gather = response.gather({
      numDigits: 1,
      timeout: 10,
      action: `/webhook/callback/option/${callSid}`,
      method: 'POST'
    });

    return { twiml: response.toString() };
  }

  /* =========================
     Business Hours Detection
  ========================== */
  isBusinessHours() {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();

    // Monday-Friday, 9 AM - 6 PM
    const isWeekday = day >= 1 && day <= 5;
    const isBusinessHour = hour >= 9 && hour < 18;

    return isWeekday && isBusinessHour;
  }

  getAfterHoursRouting() {
    return {
      name: 'after_hours',
      priority: 5,
      conditions: [
        { field: 'time', operator: 'out_of_hours', value: { start: 9, end: 17 } }
      ],
      actions: ['voicemail', 'callback_option']
    };
  }

  /* =========================
     Queue Agent Management
  ========================== */
  addAgent(agentId, capabilities = []) {
    this.activeAgents.set(agentId, {
      id: agentId,
      status: 'available',
      capabilities,
      joinedAt: new Date(),
      currentCall: null,
      totalCalls: 0
    });

    logger.info(`ðŸ‘¤ Agent ${agentId} joined with capabilities: ${capabilities.join(', ')}`);
  }

  removeAgent(agentId) {
    const agent = this.activeAgents.get(agentId);
    if (agent && agent.currentCall) {
      // Handle agent leaving during active call
      logger.warn(`ðŸ‘¤ Agent ${agentId} left during active call ${agent.currentCall}`);
    }

    this.activeAgents.delete(agentId);
    logger.info(`ðŸ‘¤ Agent ${agentId} left`);
  }

  assignAgentToCall(queueName, callSid) {
    const availableAgents = Array.from(this.activeAgents.values())
      .filter(agent => agent.status === 'available');

    if (availableAgents.length === 0) {
      return null;
    }

    // Simple round-robin assignment (can be enhanced with skill-based routing)
    const agent = availableAgents[0];

    agent.status = 'busy';
    agent.currentCall = callSid;
    agent.totalCalls += 1;

    logger.info(`ðŸ‘¤ Agent ${agent.id} assigned to call ${callSid}`);

    return agent;
  }

  releaseAgent(agentId) {
    const agent = this.activeAgents.get(agentId);
    if (agent) {
      agent.status = 'available';
      agent.currentCall = null;
      logger.info(`ðŸ‘¤ Agent ${agentId} released from call`);
    }
  }

  getAgentStats() {
    const agents = Array.from(this.activeAgents.values());

    return {
      totalAgents: agents.length,
      availableAgents: agents.filter(a => a.status === 'available').length,
      busyAgents: agents.filter(a => a.status === 'busy').length,
      agents: agents.map(agent => ({
        id: agent.id,
        status: agent.status,
        capabilities: agent.capabilities,
        totalCalls: agent.totalCalls,
        joinedAt: agent.joinedAt
      }))
    };
  }

  getPositionText(position) {
    if (position === 1) return 'first';
    if (position === 2) return 'second';
    if (position === 3) return 'third';
    return `${position}th`;
  }

  /* =========================
     Priority Queue
  ========================== */
  addToPriorityQueue(callSid) {
    return this.addToQueue(callSid, 'priority', 'high');
  }

  /* =========================
     Voicemail Handling
  ========================== */
  routeToVoicemail(callSid) {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say({
      voice: 'alice',
      language: 'en-US'
    }, 'We are currently closed. Please leave a message after the tone.');

    response.record({
      maxLength: 60,
      playBeep: true,
      action: `/webhook/voicemail/${callSid}`,
      method: 'POST'
    });

    return { twiml: response.toString() };
  }

  /* =========================
     Callback Option
  ========================== */
  offerCallback(callSid, callData) {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say({
      voice: 'alice',
      language: 'en-US'
    }, 'We are currently closed. Press 1 to schedule a callback, or leave a message.');

    const gather = response.gather({
      numDigits: 1,
      timeout: 10,
      action: `/webhook/callback/option/${callSid}`,
      method: 'POST'
    });

    return { twiml: response.toString() };
  }

  /* =========================
     Department Routing
  ========================== */
  routeToDepartment(department, callSid) {
    logger.info(`[${callSid}] Routing to ${department} department`);

    // For now, route to AI with department context
    return this.routeToAI(callSid, { context: department });
  }

  /* =========================
     Queue Status
  ========================== */
  getQueueStatus(queueName) {
    const queue = this.callQueues.get(queueName) || [];
    return {
      name: queueName,
      length: queue.length,
      calls: queue.map(call => ({
        callSid: call.callSid,
        queuedAt: call.queuedAt,
        position: call.position
      }))
    };
  }

  /* =========================
     All Queues Status
  ========================== */
  getAllQueueStatus() {
    const status = {};
    for (const [name, queue] of this.callQueues) {
      status[name] = this.getQueueStatus(name);
    }
    return status;
  }
}

export default new InboundCallService();

