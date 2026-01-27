import logger from '../utils/logger.js';
import telephonyService from './telephonyService.js';
import callStateService from './callStateService.js';
import Call from '../models/call.js';
import User from '../models/user.js';

class InboundCallService {
  constructor() {
    this.callQueues = new Map(); // Queue management
    this.ivrMenus = new Map(); // IVR configurations
    this.routingRules = new Map(); // Business routing rules
    this.activeAgents = new Map(); // Available agents
    
    this.initializeDefaultIVR();
    this.initializeRoutingRules();
    this.initializeSampleQueues(); // Add sample data for testing
    
    logger.info('✓ Inbound Call Service Initialized');
  }

  /* =========================
     Initialize Default IVR Menu
  ========================== */
  initializeDefaultIVR() {
    this.ivrMenus.set('main', {
      greeting: 'Welcome to our AI assistant. Please choose from the following options:',
      menu: [
        {
          key: '1',
          text: 'For sales and support, press 1',
          action: 'route_to_sales',
          next: 'sales'
        },
        {
          key: '2', 
          text: 'For technical support, press 2',
          action: 'route_to_tech',
          next: 'tech'
        },
        {
          key: '3',
          text: 'For billing inquiries, press 3',
          action: 'route_to_billing',
          next: 'billing'
        },
        {
          key: '4',
          text: 'To speak with our AI assistant, press 4',
          action: 'route_to_ai',
          next: null
        },
        {
          key: '0',
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
          key: '1',
          text: 'Product information, press 1',
          action: 'route_to_ai',
          context: 'product_info'
        },
        {
          key: '2',
          text: 'Pricing and plans, press 2', 
          action: 'route_to_ai',
          context: 'pricing'
        },
        {
          key: '3',
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
     Process Incoming Call
  ========================== */
  async processIncomingCall(callData) {
    try {
      const { CallSid, From, To } = callData;
      
      logger.info(`📞 Processing inbound call: ${CallSid} from ${From}`);

      // Create call record
      const { call, user } = await callStateService.createCall({
        callSid: CallSid,
        phoneNumber: From,
        direction: 'inbound',
        provider: 'twilio'
      });

      // Determine routing based on rules
      const routing = await this.determineRouting(call, user);
      
      // Execute routing actions
      const result = await this.executeRouting(callSid, routing, callData);

      return {
        success: true,
        callSid: CallSid,
        routing: routing.name,
        actions: result.actions,
        twiml: result.twiml
      };

    } catch (error) {
      logger.error('❌ Failed to process inbound call:', error);
      throw error;
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
    
    logger.info(`📍 Routing call ${call.callSid} to: ${selectedRule.name}`);
    
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

    const VoiceResponse = require('twilio').twiml.VoiceResponse;
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
    
    const VoiceResponse = require('twilio').twiml.VoiceResponse;
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
     Handle IVR Selection
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
      const option = menu.menu.find(opt => opt.key === digits);
      
      if (!option) {
        // Invalid input
        if (attempts >= maxAttempts) {
          // Max attempts reached, route to AI
          logger.warn(`[${callSid}] Max IVR attempts reached, routing to AI`);
          return this.routeToAI(callSid);
        } else {
          // Retry
          callStateService.updateCallState(callSid, {
            ivrState: { ...state.ivrState, attempts: attempts + 1 }
          });
          
          const VoiceResponse = require('twilio').twiml.VoiceResponse;
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
      return this.routeToAI(callSid);
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
        
      default:
        logger.warn(`Unknown IVR action: ${option.action}`);
        return this.routeToAI(callSid);
    }
  }

  /* =========================
     Queue Management
  ========================== */
  addToQueue(callSid, queueName) {
    if (!this.callQueues.has(queueName)) {
      this.callQueues.set(queueName, []);
    }
    
    const queue = this.callQueues.get(queueName);
    const position = queue.length + 1;
    
    queue.push({
      callSid,
      queuedAt: new Date(),
      position
    });
    
    logger.info(`[${callSid}] Added to ${queueName} queue at position ${position}`);
    
    const VoiceResponse = require('twilio').twiml.VoiceResponse;
    const response = new VoiceResponse();
    
    response.say({
      voice: 'alice',
      language: 'en-US'
    }, `You are ${this.getPositionText(position)} in the queue. Please hold.`);
    
    response.play({
      loop: 10
    }, 'https://com.twilio.music.classical.s3.amazonaws.com/MLOCKP_01.mp3');
    
    return { twiml: response.toString() };
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
    return this.addToQueue(callSid, 'priority');
  }

  /* =========================
     Voicemail Handling
  ========================== */
  routeToVoicemail(callSid) {
    const VoiceResponse = require('twilio').twiml.VoiceResponse;
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
    const VoiceResponse = require('twilio').twiml.VoiceResponse;
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

  /* =========================
     Initialize Sample Queues (for testing)
  ========================== */
  initializeSampleQueues() {
    // Sample sales queue with mock callers
    this.callQueues.set('sales', [
      {
        callSid: 'CA_sample_1',
        from: '+1234567890',
        queuedAt: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
        priority: 'normal'
      },
      {
        callSid: 'CA_sample_2',
        from: '+0987654321',
        queuedAt: new Date(Date.now() - 30000).toISOString(), // 30 seconds ago
        priority: 'high'
      }
    ]);

    // Sample support queue
    this.callQueues.set('support', [
      {
        callSid: 'CA_sample_3',
        from: '+1122334455',
        queuedAt: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
        priority: 'normal'
      }
    ]);

    logger.info('✓ Sample queues initialized for testing');
  }
}

export default new InboundCallService();
