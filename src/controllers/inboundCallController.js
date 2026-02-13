import twilio from 'twilio';
import inboundCallService from '../services/inboundCallService.js';
import callStateService from '../services/callStateService.js';
import callbackService from '../services/callbackService.js';
import workflowAudioService from '../services/workflowAudioService.js';
import ivrWorkflowEngine from '../services/ivrWorkflowEngine.js';
import logger from '../utils/logger.js';
import crypto from 'crypto';
import Call from '../models/call.js';
import ResponseFormatter from '../utils/responseFormatter.js';

// Import Socket.IO instance for real-time events
let io = null;
export const setSocketIO = (socketIO) => {
  io = socketIO;
};

class InboundCallController {
  /**
   * Helper function to get voice and language configuration
   */
  getVoiceAndLanguageConfig(voiceId) {
    const defaultVoiceId = voiceId || 'en-GB-SoniaNeural';
    const languageMap = {
      'en-GB-SoniaNeural': 'en-GB',
      'en-GB-RyanNeural': 'en-GB',
      'ta-IN-PallaviNeural': 'ta-IN',
      'ta-IN-ValluvarNeural': 'ta-IN'
    };
    const language = languageMap[defaultVoiceId] || 'en-GB';

    return { voiceId: defaultVoiceId, language };
  }

  /**
   * Helper function to validate required fields
   */
  validateRequiredFields(data, requiredFields) {
    const missing = requiredFields.filter(field => !data[field]);
    if (missing.length > 0) {
      return {
        isValid: false,
        missing,
        error: `Missing required fields: ${missing.join(', ')}`
      };
    }
    return { isValid: true };
  }

  /**
   * Helper function to create audio file data object
   */
  createAudioFileData(audioData, greetingText, voiceId) {
    const { language } = this.getVoiceAndLanguageConfig(voiceId);
    const textHash = crypto.createHash('sha256').update(greetingText).digest('hex');

    return {
      language,
      audioUrl: audioData.audioUrl,
      audioAssetId: audioData.publicId, // Standardize to audioAssetId
      duration: audioData.duration,
      fileSize: 0, // Will be populated if available
      textHash,
      generatedAt: new Date()
    };
  }

  /**
   * ðŸ“¥ Handle inbound call with enhanced routing
   */
  async handleInboundCall(req, res) {
    try {
      const { CallSid, From, To } = req.body;

      if (!CallSid || !From) {
        return res.status(400).send('Invalid inbound call data');
      }

      logger.info(`ðŸ“ž Enhanced inbound call processing: ${CallSid} from ${From}`);

      // Process through enhanced inbound service
      const result = await inboundCallService.processIncomingCall({
        CallSid,
        From,
        To
      });

      // Update call status
      await callStateService.updateCallStatus(CallSid, 'ringing', {
        routing: result.routing,
        actions: result.actions
      });

      logger.info(`[${CallSid}] Routed via: ${result.routing}`);

      res.type('text/xml');
      res.send(result.twiml);

    } catch (error) {
      logger.error('Enhanced inbound call error:', error);

      // Fallback to basic AI routing
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      response.say({
        voice: 'alice',
        language: 'en-US'
      }, 'Connecting you to our AI assistant.');

      const connect = response.connect();
      connect.stream({
        url: `wss://${req.get('host')}/media/${req.body.CallSid}`,
        track: 'both_tracks'
      });

      res.type('text/xml').status(500).send(response.toString());
    }
  }

  /**
   * ðŸŽ›ï¸ Handle IVR menu selection
   */
  async handleIVRSelection(req, res) {
    try {
      const { callSid } = req.params;
      const { Digits } = req.body;

      logger.info(`[${callSid}] IVR selection: ${Digits}`);

      const result = await inboundCallService.handleIVRSelection(callSid, Digits);

      res.type('text/xml');
      res.send(result.twiml);

    } catch (error) {
      logger.error(`[${req.params.callSid}] IVR selection error:`, error);

      // Fallback to AI
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      response.say({
        voice: 'alice',
        language: 'en-US'
      }, 'I\'ll connect you to our AI assistant.');

      const connect = response.connect();
      connect.stream({
        url: `wss://${req.get('host')}/media/${req.params.callSid}`,
        track: 'both_tracks'
      });

      res.type('text/xml').status(500).send(response.toString());
    }
  }

  /**
   * ðŸ“ž Handle call status updates from Twilio
   */
  async handleCallStatus(req, res) {
    try {
      const { CallSid, CallStatus, CallDuration, From } = req.body;

      logger.info(`[${CallSid}] Status update: ${CallStatus}`);

      // Map Twilio status to our status
      const statusMap = {
        'queued': 'initiated',
        'ringing': 'ringing',
        'in-progress': 'in-progress',
        'completed': 'completed',
        'failed': 'failed',
        'busy': 'busy',
        'no-answer': 'no-answer'
      };

      const mappedStatus = statusMap[CallStatus] || CallStatus;

      // Update call in database
      await callStateService.updateCallStatus(CallSid, mappedStatus, {
        endTime: CallStatus === 'completed' ? new Date() : null,
        duration: CallDuration ? parseInt(CallDuration) : null,
        providerData: {
          twilioStatus: CallStatus,
          twilioDuration: CallDuration
        }
      });

      // If call completed, clean up
      if (CallStatus === 'completed' || CallStatus === 'failed') {
        await callStateService.endCall(CallSid);
      }

      res.type('text/xml');
      res.send('<Response></Response>');

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Status update error:`, error);
      res.status(500).send('Error');
    }
  }

  /**
   * ðŸ“¬ Handle voicemail recording
   */
  async handleVoicemail(req, res) {
    try {
      const { callSid } = req.params;
      const { RecordingUrl, RecordingDuration } = req.body;

      logger.info(`[${callSid}] Voicemail received: ${RecordingDuration}s`);

      // Update call with voicemail info
      await callStateService.updateCallStatus(callSid, 'completed', {
        voicemail: {
          url: RecordingUrl,
          duration: RecordingDuration,
          receivedAt: new Date()
        },
        endTime: new Date()
      });

      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      response.say({
        voice: 'alice',
        language: 'en-US'
      }, 'Thank you for your message. We will get back to you soon.');

      res.type('text/xml');
      res.send(response.toString());

    } catch (error) {
      logger.error(`[${req.params.callSid}] Voicemail error:`, error);
      res.status(500).send('Error');
    }
  }

  /**
   * ðŸ“ž Handle callback request
   */
  async handleCallbackOption(req, res) {
    try {
      const { callSid } = req.params;
      const { Digits } = req.body;

      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();

      if (Digits === '1') {
        // Schedule callback
        logger.info(`[${callSid}] Callback requested`);

        response.say({
          voice: 'alice',
          language: 'en-US'
        }, 'Please enter your phone number, followed by the pound key.');

        response.gather({
          numDigits: 15,
          timeout: 10,
          finishOnKey: '#',
          action: `/webhook/callback/number/${callSid}`,
          method: 'POST'
        });

        // Update call with callback request
        await callStateService.updateCallStatus(callSid, 'callback-requested', {
          callback: {
            requested: true,
            requestedAt: new Date()
          }
        });

      } else {
        // Route to voicemail
        const voicemailResult = await inboundCallService.routeToVoicemail(callSid);
        res.type('text/xml');
        res.send(voicemailResult.twiml);
        return;
      }

      res.type('text/xml');
      res.send(response.toString());

    } catch (error) {
      logger.error(`[${req.params.callSid}] Callback option error:`, error);
      res.status(500).send('Error');
    }
  }

  /**
   * ðŸ“± Handle callback number collection
   */
  async handleCallbackNumber(req, res) {
    try {
      const { callSid } = req.params;
      const { Digits } = req.body;

      logger.info(`[${callSid}] Callback number: ${Digits}`);

      // Store callback number
      await callStateService.updateCallStatus(callSid, 'callback-scheduled', {
        callback: {
          requested: true,
          phoneNumber: Digits,
          scheduledAt: new Date()
        }
      });

      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();

      response.say({
        voice: 'alice',
        language: 'en-US'
      }, 'Thank you. We will call you back during business hours.');

      response.hangup();

      res.type('text/xml');
      res.send(response.toString());

    } catch (error) {
      logger.error(`[${req.params.callSid}] Callback number error:`, error);
      res.status(500).send('Error');
    }
  }

  /**
   * ðŸ“… Handle booking input
   */
  async handleBookingInput(req, res) {
    try {
      const { callSid } = req.params;
      const input = req.body; // Contains SpeechResult or Digits

      logger.info(`[${callSid}] Booking input received: ${JSON.stringify(input)}`);

      const result = await bookingFlowService.handleInput(callSid, input);

      res.type('text/xml');
      res.send(result.twiml);

    } catch (error) {
      logger.error(`[${req.params.callSid}] Booking input error:`, error);
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      response.say('An error occurred. Please try again later.');
      res.type('text/xml');
      res.send(response.toString());
    }
  }

  /**
   * ðŸ“Š Get queue status (for dashboard)
   */
  async getQueueStatus(req, res) {
    try {
      const { queueName } = req.params;

      if (queueName) {
        const status = inboundCallService.getQueueStatus(queueName);
        res.json(status);
      } else {
        const allStatus = inboundCallService.getAllQueueStatus();
        res.json(allStatus);
      }

    } catch (error) {
      logger.error('Get queue status error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ“ˆ Get inbound call analytics
   */
  async getInboundAnalytics(req, res) {
    try {
      const { period = 'today' } = req.query;

      // Calculate date range
      const now = new Date();
      let startDate;

      switch (period) {
        case 'today':
          startDate = new Date(now);
          startDate.setHours(0, 0, 0, 0);
          break;
        case 'week':
          startDate = new Date(now);
          startDate.setDate(now.getDate() - 7);
          break;
        case 'month':
          startDate = new Date(now);
          startDate.setMonth(now.getMonth() - 1);
          break;
        case 'year':
          startDate = new Date(now);
          startDate.setFullYear(now.getFullYear() - 1);
          break;
        default:
          startDate = new Date(now);
          startDate.setHours(0, 0, 0, 0);
      }

      // Fetch analytics data
      const inboundCalls = await Call.find({
        direction: 'inbound',
        createdAt: { $gte: startDate }
      }).sort({ createdAt: -1 });

      // Calculate metrics
      const totalCalls = inboundCalls.length;
      const completedCalls = inboundCalls.filter((c) => c.status === 'completed');
      const failedCalls = inboundCalls.filter((c) => c.status === 'failed');
      const missedCalls = inboundCalls.filter((c) => c.status === 'no-answer' || c.status === 'busy');
      const avgDuration = completedCalls.length > 0
        ? Math.round(completedCalls.reduce((sum, c) => sum + (Number(c.duration) || 0), 0) / completedCalls.length)
        : 0;

      // IVR analytics
      const ivrCalls = inboundCalls.filter((c) => c.routing && c.routing !== 'default');
      const ivrBreakdown = {};
      ivrCalls.forEach((call) => {
        const routing = call.routing || 'unknown';
        ivrBreakdown[routing] = (ivrBreakdown[routing] || 0) + 1;
      });
      const completedIVRCalls = ivrCalls.filter((c) => c.status === 'completed').length;
      const totalMenuTime = ivrCalls.reduce((sum, c) => sum + (Number(c?.ivrMetrics?.menuTime) || 0), 0);
      const withMenuTimeCount = ivrCalls.filter((c) => Number.isFinite(Number(c?.ivrMetrics?.menuTime))).length;
      const avgMenuTime = withMenuTimeCount > 0 ? Math.round(totalMenuTime / withMenuTimeCount) : 0;
      const activeIVRWorkflows = inboundCalls.filter(
        (c) => c.routing && c.routing !== 'default' && ['initiated', 'ringing', 'in-progress'].includes(c.status)
      ).length;

      // AI metrics
      const aiCalls = inboundCalls.filter((c) => (c.conversation?.length || 0) > 0 || c.aiMetrics);
      const totalExchanges = aiCalls.reduce((sum, c) => sum + (Number(c?.aiMetrics?.totalExchanges) || 0), 0);
      const avgResponseTime = aiCalls.length > 0
        ? Math.round(aiCalls.reduce((sum, c) => sum + (Number(c?.aiMetrics?.avgResponseTime) || 0), 0) / aiCalls.length)
        : 0;

      // Hourly distribution (DB-only)
      const hourlyMap = new Map();
      for (let hour = 0; hour < 24; hour++) {
        hourlyMap.set(hour, { hour, calls: 0, completed: 0 });
      }
      inboundCalls.forEach((call) => {
        const hour = new Date(call.createdAt).getHours();
        const item = hourlyMap.get(hour);
        item.calls += 1;
        if (call.status === 'completed') item.completed += 1;
      });
      const hourlyDistribution = Array.from(hourlyMap.values());

      // Daily trend breakdown (DB-only)
      const dailyMap = {};
      inboundCalls.forEach((call) => {
        const key = new Date(call.createdAt).toISOString().split('T')[0];
        if (!dailyMap[key]) {
          dailyMap[key] = { total: 0, completed: 0, duration: 0 };
        }
        dailyMap[key].total += 1;
        if (call.status === 'completed') {
          dailyMap[key].completed += 1;
          dailyMap[key].duration += Number(call.duration) || 0;
        }
      });

      // Queue analytics
      const queueData = inboundCallService.getAllQueueStatus();

      res.json({
        period,
        dateRange: {
          start: startDate,
          end: now
        },
        summary: {
          totalCalls,
          inboundCalls: totalCalls,
          outboundCalls: 0,
          completedCalls: completedCalls.length,
          failedCalls: failedCalls.length,
          missedCalls: missedCalls.length,
          successRate: totalCalls > 0 ? Math.round((completedCalls.length / totalCalls) * 100) : 0,
          answerRate: totalCalls > 0 ? Math.round((completedCalls.length / totalCalls) * 100) : 0,
          avgDuration
        },
        aiMetrics: {
          aiCalls: aiCalls.length,
          avgResponseTime,
          totalExchanges,
          aiEngagementRate: totalCalls > 0 ? Math.round((aiCalls.length / totalCalls) * 100) : 0
        },
        ivrBreakdown,
        ivrAnalytics: {
          totalIVRCalls: ivrCalls.length,
          ivrUsageRate: totalCalls > 0 ? Math.round((ivrCalls.length / totalCalls) * 100) : 0,
          avgMenuTime,
          menuCompletionRate: ivrCalls.length > 0 ? Math.round((completedIVRCalls / ivrCalls.length) * 100) : 0,
          activeIVRWorkflows,
          routingBreakdown: ivrBreakdown
        },
        queueStatus: queueData,
        hourlyDistribution,
        dailyBreakdown: dailyMap,
        recentCalls: inboundCalls
          .slice(0, 10)
      });
    } catch (error) {
      logger.error('Get inbound analytics error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ“¥ Export inbound analytics data
   */
  async exportAnalytics(req, res) {
    try {
      const { period = 'today', format = 'csv' } = req.query;

      // Get the same analytics data as getInboundAnalytics
      const mockRequest = { query: { period } };
      const analyticsResponse = await this.getInboundAnalytics(mockRequest, {
        json: (data) => data
      });

      const analyticsData = analyticsResponse;

      if (format === 'csv') {
        // Generate CSV
        const csvHeaders = [
          'Call SID', 'Phone Number', 'Status', 'Duration', 'Routing',
          'AI Calls', 'AI Exchanges', 'Created At'
        ];

        const csvRows = analyticsData.recentCalls.map(call => [
          call.callSid,
          call.phoneNumber,
          call.status,
          call.duration || 0,
          call.routing || 'N/A',
          call.aiMetrics?.aiCalls || 0,
          call.aiMetrics?.totalExchanges || 0,
          call.createdAt
        ]);

        const csvContent = [
          csvHeaders.join(','),
          ...csvRows.map(row => row.join(','))
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=inbound-analytics-${period}.csv`);
        res.send(csvContent);

      } else if (format === 'xlsx') {
        // Generate Excel (simplified version)
        const excelData = analyticsData.recentCalls.map(call => ({
          'Call SID': call.callSid,
          'Phone Number': call.phoneNumber,
          'Status': call.status,
          'Duration': call.duration || 0,
          'Routing': call.routing || 'N/A',
          'Created At': call.createdAt
        }));

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=inbound-analytics-${period}.xlsx`);
        res.json(excelData);

      } else {
        res.status(400).json({ error: 'Invalid format. Use csv or xlsx.' });
      }

    } catch (error) {
      logger.error('Export analytics error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 🎛️ Update IVR configuration
   */
  async updateIVRConfig(req, res) {
    try {
      const { menuName, config } = req.body;

      // Strict validation for required fields
      const validation = this.validateRequiredFields(req.body, ['menuName', 'config']);
      if (!validation.isValid) {
        return res.status(400).json({
          error: validation.error,
          missing: validation.missing
        });
      }

      if (!config || typeof config !== 'object') {
        return res.status(400).json({
          error: 'Config must be a valid object',
          field: 'config'
        });
      }

      // Determine IVR type early to avoid unnecessary validation
      // Consider it workflow-based if nodes array exists (even if empty) OR if it has nodes
      const isWorkflowBased = (config.nodes && Array.isArray(config.nodes)) ||
        (config.edges && Array.isArray(config.edges));

      // Centralized defaults
      const { voiceId, language } = this.getVoiceAndLanguageConfig(config.voice || config.voiceId);
      const defaultConfig = {
        voiceId,
        language,
        provider: config.provider || 'edge',
        timeout: config.timeout || 10,
        maxAttempts: config.maxAttempts || config.maxRetries || 3,
        invalidInputMessage: config.invalidInputMessage || 'Invalid selection. Please try again.'
      };

      let workflowValidationErrors = [];

      // Validation based on IVR type
      if (!isWorkflowBased) {
        // Traditional menu-based IVR validation
        if (!config.greeting || typeof config.greeting !== 'string' || !config.greeting.trim()) {
          return res.status(400).json({
            error: 'Greeting message is required and must not be empty',
            field: 'greeting'
          });
        }

        if (config.greeting.length > 1000) {
          return res.status(400).json({
            error: 'Greeting message must be less than 1000 characters',
            field: 'greeting'
          });
        }

        if (!config.menu || !Array.isArray(config.menu)) {
          return res.status(400).json({
            error: 'IVR must have menu options for traditional IVR',
            field: 'menu'
          });
        }

        if (config.menu.length === 0) {
          return res.status(400).json({
            error: 'IVR menu must have at least one option',
            field: 'menu'
          });
        }

        // Validate each menu option
        for (let i = 0; i < config.menu.length; i++) {
          const option = config.menu[i];
          const digit = option.digit || option.key;

          if (!digit || !option.action || !option.target) {
            return res.status(400).json({
              error: `Menu option ${i + 1} is incomplete`,
              field: `menu[${i}]`,
              missing: {
                key: !digit,
                action: !option.action,
                target: !option.target
              },
              details: `Option requires: digit (key), action, and destination (target)`
            });
          }

          // Validate digit type and format
          if (typeof digit !== 'string' && typeof digit !== 'number') {
            return res.status(400).json({
              error: `Invalid digit type in option ${i + 1}: ${typeof digit}`,
              field: `menu[${i}].digit`,
              details: 'Digit must be a string or number'
            });
          }

          const digitStr = String(digit);
          if (!/^[0-9*#]$/.test(digitStr)) {
            return res.status(400).json({
              error: `Invalid digit in option ${i + 1}: "${digitStr}"`,
              field: `menu[${i}].digit`,
              details: 'Digit must be 0-9, *, or #'
            });
          }

          // Validate action
          const validActions = ['transfer', 'queue', 'voicemail', 'submenu', 'ai-assistant'];
          if (!validActions.includes(option.action)) {
            return res.status(400).json({
              error: `Invalid action in option ${i + 1}: "${option.action}"`,
              field: `menu[${i}].action`,
              details: `Action must be one of: ${validActions.join(', ')}`
            });
          }
        }

        // Check for duplicate keys
        const keys = config.menu.map(opt => opt.digit || opt.key);
        const seenKeys = new Set();
        const duplicates = [];

        for (const key of keys) {
          if (seenKeys.has(key)) {
            duplicates.push(key);
          } else {
            seenKeys.add(key);
          }
        }

        if (duplicates.length > 0) {
          return res.status(400).json({
            error: `Duplicate menu options found: ${duplicates.join(', ')}`,
            field: 'menu',
            details: 'Each digit must be unique in the menu'
          });
        }
      } else {
        // Workflow-based IVR validation (simplified)
        logger.info(`Workflow-based IVR detected with ${config.nodes.length} nodes`);

        if (!Array.isArray(config.nodes)) {
          return res.status(400).json({
            error: 'Workflow configuration must have nodes array',
            field: 'nodes'
          });
        }

        // Ensure edges array exists
        if (!config.edges) {
          config.edges = [];
        }

        // Validate workflow graph (only for active workflows or when there are nodes)
        const configForValidation = {
          nodes: config.nodes,
          edges: config.edges || [],
          config: config.config || {}
        };

        // Only validate workflow graph if it's not a draft or has nodes to validate
        if (config.status !== 'draft' && configForValidation.nodes.length > 0) {
          const graphErrors = ivrWorkflowEngine.validateWorkflowGraph(configForValidation);
          workflowValidationErrors = graphErrors;

          if (graphErrors.length > 0) {
            return res.status(400).json({
              error: 'Workflow validation failed',
              details: graphErrors
            });
          }
        }
      }

      // Import Workflow model to save to database
      const { default: Workflow } = await import('../models/Workflow.js');

      // Check if menu already exists by multiple identifiers
      let menu = null;

      logger.info('ðŸ” DEBUG: Searching for menu with menuName:', menuName);

      // Try to find by ObjectId first (if menuName looks like a valid ObjectId)
      if (menuName && menuName.length === 24 && /^[0-9a-fA-F]{24}$/.test(menuName)) {
        try {
          const { ObjectId } = await import('mongodb');
          menu = await Workflow.findOne({ _id: new ObjectId(menuName) });
          logger.info('ðŸ” DEBUG: Found by ObjectId:', menu?._id);
        } catch (err) {
          // Invalid ObjectId, continue with other searches
        }
      }

      // If not found by _id, try by promptKey and displayName
      if (!menu) {
        menu = await Workflow.findOne({
          $or: [
            { promptKey: menuName },
            { displayName: menuName }
          ]
        });
        logger.info('ðŸ” DEBUG: Found by promptKey/displayName:', menu?._id, 'promptKey:', menu?.promptKey, 'displayName:', menu?.displayName);
      }

      logger.info('ðŸ” DEBUG: Final menu result:', menu ? 'EXISTING - WILL UPDATE' : 'NOT FOUND - WILL CREATE');

      // Track whether this is a create or update operation
      const wasExistingMenu = !!menu;

      // Generate TTS audio for greeting/audio nodes via Python service
      let audioData = null;
      let greetingText = null;

      if (!isWorkflowBased) {
        // Traditional IVR - use config.greeting
        greetingText = config.greeting;

        // Early validation for greeting text before TTS generation
        if (!greetingText || !greetingText.trim()) {
          return res.status(400).json({
            error: 'Greeting text is required for TTS audio generation',
            field: 'greeting'
          });
        }
      } else {
        // Workflow-based IVR - find greeting or audio node
        const greetingNode = (config.nodes || []).find(node => node.type === 'greeting');
        const audioNode = (config.nodes || []).find(node => node.type === 'audio');

        if (audioNode) {
          // Audio node takes precedence
          greetingText = audioNode.data.mode === 'tts' ? audioNode.data.messageText : null;
          logger.info(`ðŸ”§ Using audio node for workflow ${menuName}: "${greetingText}"`);
        } else if (greetingNode) {
          // Fallback to greeting node for backward compatibility
          greetingText = greetingNode.data.text || 'Welcome to our service!';
          logger.info(`ðŸ”§ Using greeting node for workflow ${menuName}: "${greetingText}"`);
        } else {
          // No greeting or audio node found
          greetingText = 'Welcome to our service!';
          logger.info(`ðŸ”§ Using default greeting for workflow ${menuName}: "${greetingText}"`);
        }
      }

      // Generate TTS audio if we have greeting text
      if (greetingText && greetingText.trim()) {
        try {
          logger.info(`Generating TTS audio for IVR menu: ${menuName}`);
          audioData = await workflowAudioService.generateSingleAudio(
            greetingText,
            voiceId,
            language
          );
          logger.info(`ðŸŽµ TTS audio generated successfully:`, {
            audioUrl: audioData?.audioUrl,
            audioAssetId: audioData?.publicId,
            duration: audioData?.duration,
            fullAudioData: audioData
          });
        } catch (audioError) {
          logger.error(`TTS audio generation failed for menu ${menuName}:`, {
            error: audioError.message,
            stack: audioError.stack,
            greetingText,
            voiceId
          });
          // Continue without audio - menu will work with text-to-speech fallback
        }
      }

      // Simplified create/update logic
      const menuData = {
        promptKey: menuName,
        displayName: config.displayName || menuName.replace(/ivr_[a-z]+_[0-9]+/, 'New IVR') || menuName,
        nodes: config.nodes || [],
        edges: config.edges || [],
        config: defaultConfig,
        tags: config.tags || [],
        status: config.status || 'draft',
        isActive: true
      };

      // Add greeting text for traditional IVRs
      if (!isWorkflowBased) {
        menuData.text = config.greeting;
      } else {
        // For workflow-based IVRs, ensure there's at least a greeting node
        const greetingNode = menuData.nodes.find(node => node.type === 'greeting');
        if (!greetingNode) {
          logger.info(`ðŸ”§ Adding default greeting node to workflow ${menuName} - no greeting node found`);
          menuData.nodes.push({
            id: 'default-greeting',
            type: 'greeting',
            data: {
              text: 'Welcome to our service!',
              voiceId,
              language
            },
            position: { x: 100, y: 100 }
          });
        }
      }

      // Add audio files if generation succeeded
      if (audioData && greetingText) {
        const newTextHash = crypto.createHash('sha256').update(greetingText).digest('hex');

        // Check for existing menu to avoid duplicates
        if (menu) {
          const existingAudioFile = (menu.audioFiles || []).find(audioFile =>
            audioFile.textHash === newTextHash
          );

          if (existingAudioFile) {
            logger.info(`ðŸ”„ Audio file with same text already exists, skipping generation. Hash: ${newTextHash}`);
          } else {
            const audioFileData = this.createAudioFileData(audioData, greetingText, voiceId);
            menuData.audioFiles = (menu.audioFiles || []).concat(audioFileData);
          }
        } else {
          // New menu - always add audio
          menuData.audioFiles = [this.createAudioFileData(audioData, greetingText, voiceId)];
        }
      }

      // Create or update menu
      if (menu) {
        // Update existing menu
        Object.assign(menu, menuData);
        menu.updatedAt = new Date();
        await menu.save();
      } else {
        // Create new menu
        menu = new Workflow(menuData);
        await menu.save();
      }

      // Also update in-memory service for runtime use
      inboundCallService.ivrMenus.set(menuName, {
        ...config,
        timeout: config.timeout || 10,
        maxAttempts: config.maxAttempts || 3,
        invalidInputMessage: config.invalidInputMessage || 'Invalid selection. Please try again.'
      });

      logger.info(`IVR menu updated: ${menuName}`);

      // Determine if this was a create or update operation
      // Use explicit tracking instead of fragile timestamp-based detection
      const isCreate = !wasExistingMenu;

      // Emit real-time Socket.IO events for frontend updates
      if (io) {
        // Format complete IVR data for frontend using Workflow structure
        const completeIVRData = {
          _id: menu._id,
          promptKey: menu.promptKey,
          displayName: menu.displayName,
          greeting: {
            text: config.greeting,
            audioUrl: audioData?.audioUrl || null,
            audioAssetId: audioData?.publicId || null,
            voice: menu.config?.voiceId || 'en-GB-SoniaNeural',
            language: menu.config?.language || 'en-GB'
          },
          menuOptions: (config.menu || []).map(opt => ({
            digit: opt.digit || opt.key,
            label: opt.label || opt.action,
            action: opt.action,
            destination: opt.destination || opt.target || ''
          })),
          settings: {
            timeout: menu.config?.timeout || 10,
            maxAttempts: menu.config?.maxAttempts || 3,
            invalidInputMessage: menu.config?.invalidInputMessage || 'Invalid selection. Please try again.'
          },
          workflowConfig: menu.workflowConfig || {
            nodes: menu.nodes || [],
            edges: menu.edges || [],
            settings: menu.config
          },
          status: menu.status || (menu.isActive ? 'active' : 'inactive'),
          tags: menu.tags || [],
          nodeCount: menu.nodeCount,
          edgeCount: menu.edgeCount,
          isComplete: menu.isComplete,
          createdAt: menu.createdAt,
          updatedAt: menu.updatedAt
        };

        const eventData = {
          menuId: menu._id,
          menuName: menu.promptKey,
          ivrMenu: completeIVRData,
          timestamp: new Date().toISOString()
        };

        if (isCreate) {
          io.emit('ivr_config_created', eventData);
          logger.info(`ðŸ“¡ Socket.IO emitted: ivr_config_created for ${menuName} with complete data`);
        } else {
          io.emit('ivr_config_updated', eventData);
          logger.info(`ðŸ“¡ Socket.IO emitted: ivr_config_updated for ${menuName} with complete data`);
        }
      }

      const audioFile = Array.isArray(menu.audioFiles) && menu.audioFiles.length > 0
        ? menu.audioFiles[menu.audioFiles.length - 1]
        : null;

      const action = isCreate ? 'created' : 'updated';
      res.json({
        success: true,
        message: `IVR menu '${menuName}' ${action} successfully`,
        ivrMenu: {
          _id: menu._id,
          ivrName: menu.promptKey,
          displayName: menu.displayName, // Add displayName to response
          greeting: {
            text: menu.text,
            audioUrl: audioData?.audioUrl || null,
            audioAssetId: audioData?.audioAssetId || null, // âœ… FIXED: Use correct field from TTS response
            voice: config.voiceId || config.voice || menu.menuConfig?.voiceId || 'en-GB-SoniaNeural'
          },
          menuOptions: (menu.menuConfig?.options || []).map(opt => ({
            _id: opt._id,
            digit: opt.digit,
            label: opt.label || opt.action,
            action: opt.action,
            destination: opt.target || opt.destination || ''
          })),
          settings: {
            timeout: config.timeout || 10,
            maxAttempts: config.maxAttempts || 3,
            invalidInputMessage: config.invalidInputMessage || 'Invalid selection. Please try again.'
          },
          // âœ… ALWAYS include workflowConfig with proper structure for frontend canvas
          workflowConfig: {
            nodes: menu.nodes || [],
            edges: menu.edges || [],
            settings: menu.config || {}
          },
          status: menu.isActive ? 'active' : 'inactive',
          tags: menu.tags || [],
          createdAt: menu.createdAt,
          updatedAt: menu.updatedAt
        },
        ...(workflowValidationErrors.length > 0 ? { workflowValidationErrors } : {})
      });

    } catch (error) {
      logger.error('Update IVR config error:', error);
      res.status(500).json({
        error: error.message
      });
    }
  }

  /**
   * ðŸ—‘ï¸ Delete IVR configuration
   */
  async deleteIVRConfig(req, res) {
    try {
      const { menuId } = req.params;

      // Strict validation for required fields
      const validation = this.validateRequiredFields(req.params, ['menuId']);
      if (!validation.isValid) {
        return res.status(400).json({
          error: validation.error,
          missing: validation.missing
        });
      }

      // Import Workflow model and Cloudinary utils
      const { default: Workflow } = await import('../models/Workflow.js');
      const { default: cloudinaryUtils } = await import('../utils/cloudinaryUtils.js');

      // Find menu by ID (safer than name-based deletion)
      let menu = null;
      try {
        const { ObjectId } = await import('mongodb');
        menu = await Workflow.findById(menuId);
      } catch (err) {
        logger.error('Invalid ObjectId format:', menuId, err);
        return res.status(400).json({
          error: 'Invalid menu ID format',
          code: 'INVALID_MENU_ID'
        });
      }

      if (!menu) {
        return res.status(404).json({
          error: `IVR menu with ID '${menuId}' not found`,
          code: 'MENU_NOT_FOUND'
        });
      }

      // Check if menu is being used in any active calls
      // PERFORMANCE NOTE: Ensure MongoDB has compound index on { routing: 1, status: 1 } for optimal performance
      const activeCallsWithMenu = await Call.countDocuments({
        routing: menu.promptKey,
        status: { $in: ['initiated', 'ringing', 'in-progress'] }
      });

      if (activeCallsWithMenu > 0) {
        return res.status(400).json({
          error: `Cannot delete IVR menu '${menu.promptKey}' - ${activeCallsWithMenu} active calls are using it`,
          code: 'IVR_MENU_IN_USE'
        });
      }

      // ðŸ—‘ï¸ STEP 1: Delete Cloudinary audio assets (VERY IMPORTANT)
      let cloudinaryAssetsDeleted = false;
      const deletedAudioAssetIds = []; // Track deleted asset IDs for response

      try {
        // NOTE: Greeting audio is stored in audioFiles array, not as separate menu.greeting object
        // This ensures consistency with the update flow where all audio goes to audioFiles

        // Delete workflow audio files if they exist (includes greeting audio)
        if (menu.audioFiles && Array.isArray(menu.audioFiles)) {
          for (const audioFile of menu.audioFiles) {
            if (audioFile.audioAssetId) {
              await cloudinaryUtils.deleteFile(audioFile.audioAssetId);
              deletedAudioAssetIds.push(audioFile.audioAssetId);
              logger.info(`ðŸ—‘ï¸ Deleted audio from Cloudinary: ${audioFile.audioAssetId}`);
            }
          }
        }

        // Delete any additional audio assets in menuOptions
        if (menu.menuOptions && Array.isArray(menu.menuOptions)) {
          for (const option of menu.menuOptions) {
            if (option.audioAssetId) {
              await cloudinaryUtils.deleteFile(option.audioAssetId);
              deletedAudioAssetIds.push(option.audioAssetId);
              logger.info(`ðŸ—‘ï¸ Deleted option audio from Cloudinary: ${option.audioAssetId}`);
            }
          }
        }

        cloudinaryAssetsDeleted = true;
      } catch (cloudinaryError) {
        logger.error('âš ï¸ Failed to delete Cloudinary assets:', cloudinaryError);
        // Continue with DB deletion even if Cloudinary fails
      }

      // ðŸ—‘ï¸ STEP 2: Delete from database (hard delete, not soft delete)
      await Workflow.findByIdAndDelete(menuId);

      // Remove from in-memory service
      inboundCallService.ivrMenus.delete(menu.promptKey);

      logger.info(`ðŸ—‘ï¸ IVR menu deleted from database: ${menu.promptKey} (ID: ${menuId})`);

      // ðŸ“¡ STEP 3: Emit socket event for frontend updates
      if (io) {
        const eventData = {
          menuId: menu._id,
          menuName: menu.promptKey || menu.ivrName,
          cloudinaryAssetsDeleted,
          deletedAudioAssetIds, // Include deleted asset IDs for frontend tracking
          deletedAt: new Date().toISOString()
        };

        io.emit('ivr_config_deleted', eventData);
        logger.info(`ðŸ“¡ Socket.IO emitted: ivr_config_deleted for ${menu.promptKey}`);
      }

      // âœ… STEP 4: Return comprehensive success response
      res.json({
        success: true,
        message: `IVR menu '${menu.promptKey || menu.ivrName}' deleted successfully`,
        data: {
          menuId: menu._id,
          menuName: menu.promptKey || menu.ivrName,
          cloudinaryAssetsDeleted,
          deletedAudioAssetIds, // Include deleted asset IDs for frontend consistency
          deletedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Delete IVR config error:', error);
      res.status(500).json({
        error: error.message
      });
    }
  }

  /**
   * ðŸ“‹ Get IVR configurations
   */
  async getIVRConfigs(req, res) {
    try {
      // Import Workflow model to get data from database
      const { default: Workflow } = await import('../models/Workflow.js');

      logger.info('ðŸ” Querying IVR workflows with filter: { isActive: true }');

      // Get all IVR workflows from database
      const menus = await Workflow.find({ isActive: true })
        .select('promptKey displayName text nodes edges config status tags createdAt updatedAt')
        .sort({ promptKey: 1 });

      logger.info(`ðŸ“Š Found ${menus.length} IVR menus in database`);
      logger.info('ðŸ“‹ Raw menu data:', JSON.stringify(menus, null, 2));

      // Transform to match expected format using Workflow structure
      const formattedMenus = menus.map(menu => {
        const greetingNode = menu.nodes.find(node => node.type === 'greeting');
        const inputNodes = menu.nodes.filter(node => node.type === 'input');

        // Use menu.text for consistency with other parts of the system
        // Fall back to greeting node text, then 'Welcome' as last resort
        const greetingText = menu.text || greetingNode?.data?.text || 'Welcome';

        // Validate input nodes and filter out incomplete ones
        const validInputNodes = inputNodes.filter(node => {
          if (!node.data?.digit) {
            logger.warn(`âš ï¸ Input node missing digit in menu ${menu.promptKey}, skipping node`);
            return false;
          }
          return true;
        });

        return {
          _id: menu._id,
          promptKey: menu.promptKey,
          displayName: menu.displayName,
          greeting: {
            text: greetingText,
            voice: menu.config?.voiceId || 'en-GB-SoniaNeural',
            language: menu.config?.language || 'en-GB'
          },
          menuOptions: validInputNodes.map(node => ({
            digit: node.data.digit, // No fallback - digit is required
            label: node.data?.label || 'Option',
            action: node.data?.action || 'transfer',
            destination: node.data?.destination || ''
          })),
          settings: {
            timeout: menu.config?.timeout || 10,
            maxAttempts: menu.config?.maxAttempts || 3,
            invalidInputMessage: menu.config?.invalidInputMessage || 'Invalid selection. Please try again.'
          },
          workflowConfig: {
            nodes: menu.nodes,
            edges: menu.edges,
            settings: menu.config
          },
          status: menu.status || (menu.isActive ? 'active' : 'inactive'),
          tags: menu.tags || [],
          nodeCount: menu.nodeCount,
          edgeCount: menu.edgeCount,
          isComplete: menu.isComplete,
          createdAt: menu.createdAt,
          updatedAt: menu.updatedAt
        };
      });

      logger.info('âœ… Formatted menus:', JSON.stringify(formattedMenus, null, 2));

      res.json({
        success: true,
        ivrMenus: formattedMenus
      });

    } catch (error) {
      logger.error('Get IVR configs error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ“ž Schedule callback for inbound call
   */
  async scheduleCallback(req, res) {
    try {
      const { callSid, phoneNumber, priority, scheduledTime } = req.body;

      // Strict validation for required fields
      const validation = this.validateRequiredFields(req.body, ['callSid', 'phoneNumber']);
      if (!validation.isValid) {
        return res.status(400).json({
          error: validation.error,
          missing: validation.missing
        });
      }

      // Validate scheduledTime if provided
      let parsedScheduledTime = null;
      if (scheduledTime) {
        parsedScheduledTime = new Date(scheduledTime);
        if (isNaN(parsedScheduledTime.getTime())) {
          return res.status(400).json({
            error: 'Invalid scheduledTime format',
            details: 'scheduledTime must be a valid date string or timestamp'
          });
        }

        // Ensure scheduled time is in the future
        if (parsedScheduledTime <= new Date()) {
          return res.status(400).json({
            error: 'scheduledTime must be in the future',
            details: 'Cannot schedule callbacks for past times'
          });
        }
      }

      const callback = await inboundCallService.handleCallbackRequest(
        callSid,
        phoneNumber,
        priority || 'normal',
        parsedScheduledTime
      );

      res.json({
        success: true,
        callback: {
          id: callback._id,
          callSid: callback.callSid,
          phoneNumber: callback.phoneNumber,
          priority: callback.priority,
          scheduledFor: callback.scheduledFor
        }
      });

    } catch (error) {
      logger.error('Schedule callback error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ“ž Get callback statistics
   */
  async getCallbackStats(req, res) {
    try {
      const { period = 'today' } = req.query;

      const stats = await callbackService.getCallbackStats(period);

      res.json(stats);

    } catch (error) {
      logger.error('Get callback stats error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ“ž Get active callbacks
   */
  async getActiveCallbacks(req, res) {
    try {
      const callbacks = await callbackService.getActiveCallbacks();

      res.json({
        success: true,
        callbacks: callbacks.map(cb => ({
          id: cb._id,
          callSid: cb.callSid,
          phoneNumber: cb.phoneNumber,
          priority: cb.priority,
          scheduledFor: cb.scheduledFor,
          status: cb.status,
          attempts: cb.attempts,
          nextAttemptAt: cb.nextAttemptAt
        }))
      });

    } catch (error) {
      logger.error('Get active callbacks error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ“ž Cancel callback
   */
  async cancelCallback(req, res) {
    try {
      const { callbackId } = req.params;
      const { reason } = req.body;

      // Strict validation for required fields
      const validation = this.validateRequiredFields(req.params, ['callbackId']);
      if (!validation.isValid) {
        return res.status(400).json({
          error: validation.error,
          missing: validation.missing
        });
      }

      const callback = await callbackService.cancelCallback(callbackId, reason);

      res.json({
        success: true,
        callback: {
          id: callback._id,
          callSid: callback.callSid,
          phoneNumber: callback.phoneNumber,
          status: callback.status,
          notes: callback.notes
        }
      });

    } catch (error) {
      logger.error('Cancel callback error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ“ž Reschedule callback
   */
  async rescheduleCallback(req, res) {
    try {
      const { callbackId } = req.params;
      const { scheduledTime, reason } = req.body;

      // Strict validation for required fields
      const paramValidation = this.validateRequiredFields(req.params, ['callbackId']);
      if (!paramValidation.isValid) {
        return res.status(400).json({
          error: paramValidation.error,
          missing: paramValidation.missing
        });
      }

      const bodyValidation = this.validateRequiredFields(req.body, ['scheduledTime']);
      if (!bodyValidation.isValid) {
        return res.status(400).json({
          error: bodyValidation.error,
          missing: bodyValidation.missing
        });
      }

      // Validate scheduledTime
      const parsedScheduledTime = new Date(scheduledTime);
      if (isNaN(parsedScheduledTime.getTime())) {
        return res.status(400).json({
          error: 'Invalid scheduledTime format',
          details: 'scheduledTime must be a valid date string or timestamp'
        });
      }

      // Ensure scheduled time is in the future
      if (parsedScheduledTime <= new Date()) {
        return res.status(400).json({
          error: 'scheduledTime must be in the future',
          details: 'Cannot reschedule callbacks for past times'
        });
      }

      const callback = await callbackService.rescheduleCallback(
        callbackId,
        parsedScheduledTime,
        reason
      );

      res.json({
        success: true,
        callback: {
          id: callback._id,
          callSid: callback.callSid,
          phoneNumber: callback.phoneNumber,
          scheduledFor: callback.scheduledFor,
          status: callback.status
        }
      });

    } catch (error) {
      logger.error('Reschedule callback error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ“ž Get callbacks by phone number
   */
  async getCallbacksByPhone(req, res) {
    try {
      const { phoneNumber } = req.params;

      // Strict validation for required fields
      const validation = this.validateRequiredFields(req.params, ['phoneNumber']);
      if (!validation.isValid) {
        return res.status(400).json({
          error: validation.error,
          missing: validation.missing
        });
      }

      const callbacks = await callbackService.getCallbacksByPhone(phoneNumber);

      res.json({
        success: true,
        callbacks: callbacks.map(cb => ({
          id: cb._id,
          callSid: cb.callSid,
          phoneNumber: cb.phoneNumber,
          priority: cb.priority,
          scheduledFor: cb.scheduledFor,
          status: cb.status,
          attempts: cb.attempts,
          completedAt: cb.completedAt,
          notes: cb.notes
        }))
      });

    } catch (error) {
      logger.error('Get callbacks by phone error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ‘¥ Get agent statistics
   */
  async getAgentStats(req, res) {
    try {
      const stats = inboundCallService.getAgentStats();

      res.json(stats);

    } catch (error) {
      logger.error('Get agent stats error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ‘¥ Add agent to system
   * NOTE: Agents are stored in memory only. Consider DB persistence for production use.
   */
  async addAgent(req, res) {
    try {
      const { agentId, capabilities } = req.body;

      // Strict validation for required fields
      const validation = this.validateRequiredFields(req.body, ['agentId']);
      if (!validation.isValid) {
        return res.status(400).json({
          error: validation.error,
          missing: validation.missing
        });
      }

      inboundCallService.addAgent(agentId, capabilities || []);

      res.json({
        success: true,
        message: `Agent ${agentId} added successfully`,
        agent: {
          id: agentId,
          capabilities: capabilities || [],
          note: 'Agent stored in memory only - will be lost on server restart'
        }
      });

    } catch (error) {
      logger.error('Add agent error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * ðŸ‘¥ Remove agent from system
   * NOTE: Agents are stored in memory only. Consider DB persistence for production use.
   */
  async removeAgent(req, res) {
    try {
      const { agentId } = req.params;

      // Strict validation for required fields
      const validation = this.validateRequiredFields(req.params, ['agentId']);
      if (!validation.isValid) {
        return res.status(400).json({
          error: validation.error,
          missing: validation.missing
        });
      }

      inboundCallService.removeAgent(agentId);

      res.json({
        success: true,
        message: `Agent ${agentId} removed successfully`,
        note: 'Agent was stored in memory only'
      });

    } catch (error) {
      logger.error('Remove agent error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

export default InboundCallController;

