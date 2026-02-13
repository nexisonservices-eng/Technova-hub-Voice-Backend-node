import logger from '../utils/logger.js';
import AIBridgeService from './aiBridgeService.js';
import callStateService from './callStateService.js';
import { emitInboundCallUpdate, emitCallUpdate } from '../sockets/unifiedSocket.js';

class AIAssistantService {
  constructor() {
    this.activeAISessions = new Map(); // callSid -> AI session data
    this.fallbackTriggers = [
      'no_agent_available',
      'ivR_timeout',
      'invalid_input_max_attempts',
      'emergency_routing',
      'after_hours'
    ];
    
    logger.info('✓ AI Assistant Service Initialized');
  }

  /**
   * ==========================================
   * Initialize AI Assistant for Call
   * ==========================================
   */
  async initializeAIAssistant(callSid, context = {}) {
    try {
      // Check if AI service is available
      const healthCheck = await AIBridgeService.checkHealth();
      if (healthCheck.status !== 'ok') {
        throw new Error('AI service unavailable');
      }

      // Create AI bridge client
      const aiClient = new AIBridgeService(callSid);
      await aiClient.connect();

      // Store session data
      this.activeAISessions.set(callSid, {
        aiClient,
        context: {
          ...context,
          startTime: new Date(),
          callType: context.direction || 'inbound',
          broadcastId: context.broadcastId || null
        },
        startTime: Date.now(),
        lastActivity: Date.now()
      });

      logger.info(`🤖 AI Assistant initialized for call: ${callSid}`);

      // Update call state
      await callStateService.updateCallState(callSid, {
        aiAssistant: {
          active: true,
          startTime: new Date(),
          context
        }
      });

      // Emit real-time update for both inbound and broadcast calls
      const session = this.activeAISessions.get(callSid);
      if (session.context.broadcastId) {
        // This is a broadcast call
        emitCallUpdate(session.context.broadcastId, {
          callSid,
          aiAssistant: {
            active: true,
            startTime: new Date()
          },
          status: 'ai_assisted'
        });
      } else {
        // This is an inbound call
        emitInboundCallUpdate({
          callSid,
          aiAssistant: {
            active: true,
            startTime: new Date()
          },
          status: 'ai_assisted'
        });
      }

      return aiClient;
    } catch (error) {
      logger.error(`Failed to initialize AI assistant for ${callSid}:`, error);
      throw error;
    }
  }

  /**
   * ==========================================
   * Handle AI Assistant Fallback
   * ==========================================
   */
  async handleAIFallback(callSid, triggerReason, context = {}) {
    try {
      logger.info(`🤖 AI fallback triggered for ${callSid}: ${triggerReason}`);

      // Get call state
      const callState = callStateService.getCallState(callSid);
      if (!callState) {
        throw new Error('Call state not found');
      }

      // Initialize AI assistant if not already active
      let aiClient;
      const session = this.activeAISessions.get(callSid);
      
      if (!session) {
        aiClient = await this.initializeAIAssistant(callSid, {
          ...context,
          fallbackReason: triggerReason,
          originalRouting: callState.routing,
          direction: context.direction || 'inbound',
          broadcastId: context.broadcastId || null
        });
      } else {
        aiClient = session.aiClient;
        // Update context with fallback reason
        session.context.fallbackReason = triggerReason;
      }

      // Configure AI behavior based on trigger reason
      const aiConfig = this.getAIConfigForTrigger(triggerReason, context);
      
      // Send initial context to AI
      await this.sendAIContext(aiClient, aiConfig, callState);

      // Update call state
      await callStateService.updateCallState(callSid, {
        aiAssistant: {
          active: true,
          fallbackReason: triggerReason,
          config: aiConfig,
          lastActivity: new Date()
        }
      });

      // Emit real-time update for both inbound and broadcast calls
      const currentSession = this.activeAISessions.get(callSid);
      if (currentSession.context.broadcastId) {
        // This is a broadcast call
        emitCallUpdate(currentSession.context.broadcastId, {
          callSid,
          aiAssistant: {
            active: true,
            fallbackReason: triggerReason,
            config: aiConfig
          },
          status: 'ai_assisted',
          timestamp: new Date()
        });
      } else {
        // This is an inbound call
        emitInboundCallUpdate({
          callSid,
          aiAssistant: {
            active: true,
            fallbackReason: triggerReason,
            config: aiConfig
          },
          status: 'ai_assisted',
          timestamp: new Date()
        });
      }

      return aiClient;
    } catch (error) {
      logger.error(`AI fallback failed for ${callSid}:`, error);
      throw error;
    }
  }

  /**
   * ==========================================
   * Get AI Configuration Based on Trigger
   * ==========================================
   */
  getAIConfigForTrigger(triggerReason, context) {
    const baseConfig = {
      language: 'en-GB',
      voice: 'alice',
      maxResponseTime: 5000,
      enableRecording: true
    };

    switch (triggerReason) {
      case 'no_agent_available':
        return {
          ...baseConfig,
          greeting: 'All our agents are currently busy. I am your AI assistant and can help you with basic inquiries or schedule a callback.',
          capabilities: ['answer_questions', 'schedule_callback', 'take_message'],
          escalationEnabled: true,
          maxDuration: 300 // 5 minutes
        };

      case 'ivR_timeout':
        return {
          ...baseConfig,
          greeting: 'I apologize for the confusion. I am your AI assistant. How can I help you today?',
          capabilities: ['answer_questions', 'route_to_department', 'schedule_callback'],
          escalationEnabled: true,
          maxDuration: 240 // 4 minutes
        };

      case 'invalid_input_max_attempts':
        return {
          ...baseConfig,
          greeting: 'I understand you need assistance. I am your AI assistant and can help you directly.',
          capabilities: ['answer_questions', 'route_to_department', 'take_message'],
          escalationEnabled: false, // Keep with AI to avoid further frustration
          maxDuration: 300
        };

      case 'emergency_routing':
        return {
          ...baseConfig,
          greeting: 'This appears to be an emergency. I am connecting you to help immediately while gathering information.',
          capabilities: ['emergency_handling', 'gather_info', 'escalate_immediately'],
          escalationEnabled: true,
          escalationPriority: 'urgent',
          maxDuration: 600 // 10 minutes for emergency
        };

      case 'after_hours':
        return {
          ...baseConfig,
          greeting: 'We are currently closed. I am your AI assistant. I can help with basic questions or schedule a callback for tomorrow.',
          capabilities: ['answer_basic_questions', 'schedule_callback', 'take_message'],
          escalationEnabled: false,
          maxDuration: 180 // 3 minutes
        };

      default:
        return {
          ...baseConfig,
          greeting: 'Hello, I am your AI assistant. How can I help you today?',
          capabilities: ['answer_questions', 'route_to_department', 'schedule_callback'],
          escalationEnabled: true,
          maxDuration: 300
        };
    }
  }

  /**
   * ==========================================
   * Send Initial Context to AI
   * ==========================================
   */
  async sendAIContext(aiClient, config, callState) {
    try {
      const contextMessage = {
        type: 'context',
        call_id: aiClient.callId,
        config: {
          greeting: config.greeting,
          capabilities: config.capabilities,
          escalation_enabled: config.escalationEnabled,
          max_duration: config.maxDuration
        },
        caller_info: {
          phone_number: callState.call?.phoneNumber,
          user_id: callState.user?._id,
          previous_calls: callState.user?.callCount || 0,
          vip_status: callState.user?.vip || false
        },
        call_context: {
          original_routing: callState.routing,
          department: callState.routing || 'general',
          language: config.language,
          fallback_reason: config.fallbackReason
        }
      };

      aiClient.sendText(JSON.stringify(contextMessage));
      logger.info(`🤖 AI context sent for call: ${aiClient.callId}`);

    } catch (error) {
      logger.error(`Failed to send AI context for ${aiClient.callId}:`, error);
      throw error;
    }
  }

  /**
   * ==========================================
   * Handle AI Escalation
   * ==========================================
   */
  async handleAIEscalation(callSid, escalationReason, priority = 'normal') {
    try {
      logger.info(`🚨 AI escalation requested for ${callSid}: ${escalationReason}`);

      const session = this.activeAISessions.get(callSid);
      if (!session) {
        throw new Error('AI session not found');
      }

      // Update call state with escalation info
      await callStateService.updateCallState(callSid, {
        aiAssistant: {
          ...session.context,
          escalation: {
            requested: true,
            reason: escalationReason,
            priority,
            requestedAt: new Date()
          }
        }
      });

      // End AI session
      await this.endAISession(callSid);

      // Route to appropriate escalation path
      // This could be routing to human agent, supervisor, or emergency services
      await this.routeEscalation(callSid, escalationReason, priority);

      // Emit escalation update
      emitInboundCallUpdate({
        callSid,
        escalation: {
          requested: true,
          reason: escalationReason,
          priority
        },
        timestamp: new Date()
      });

    } catch (error) {
      logger.error(`AI escalation failed for ${callSid}:`, error);
      throw error;
    }
  }

  /**
   * ==========================================
   * Route Escalation
   * ==========================================
   */
  async routeEscalation(callSid, escalationReason, priority) {
    // This would integrate with your routing system
    // For now, we'll log and could trigger different actions based on reason
    
    switch (escalationReason) {
      case 'emergency':
        logger.warn(`🚨 Emergency escalation for ${callSid}`);
        // Could trigger emergency protocols, alert supervisors, etc.
        break;
      
      case 'complex_issue':
        logger.info(`🔧 Complex issue escalation for ${callSid}`);
        // Could route to specialized department or supervisor
        break;
      
      case 'customer_request':
        logger.info(`👤 Customer requested escalation for ${callSid}`);
        // Could prioritize in queue or route to supervisor
        break;
      
      default:
        logger.info(`📞 Standard escalation for ${callSid}`);
    }
  }

  /**
   * ==========================================
   * End AI Session
   * ==========================================
   */
  async endAISession(callSid) {
    try {
      const session = this.activeAISessions.get(callSid);
      if (!session) {
        return;
      }

      // Disconnect AI client
      session.aiClient.disconnect();

      // Remove from active sessions
      this.activeAISessions.delete(callSid);

      // Update call state
      await callStateService.updateCallState(callSid, {
        aiAssistant: {
          active: false,
          endTime: new Date(),
          duration: Date.now() - session.startTime
        }
      });

      // Emit real-time update for both inbound and broadcast calls
      if (session.context.broadcastId) {
        // This is a broadcast call
        emitCallUpdate(session.context.broadcastId, {
          callSid,
          aiAssistant: {
            active: false,
            endTime: new Date(),
            duration: Date.now() - session.startTime
          },
          status: 'ai_session_ended',
          timestamp: new Date()
        });
      } else {
        // This is an inbound call
        emitInboundCallUpdate({
          callSid,
          aiAssistant: {
            active: false,
            endTime: new Date(),
            duration: Date.now() - session.startTime
          },
          status: 'ai_session_ended',
          timestamp: new Date()
        });
      }

      logger.info(`🤖 AI session ended for call: ${callSid}`);

    } catch (error) {
      logger.error(`Failed to end AI session for ${callSid}:`, error);
    }
  }

  /**
   * ==========================================
   * Get AI Session Status
   * ==========================================
   */
  getAISessionStatus(callSid) {
    const session = this.activeAISessions.get(callSid);
    
    if (!session) {
      return {
        active: false,
        message: 'No active AI session'
      };
    }

    return {
      active: true,
      startTime: session.startTime,
      lastActivity: session.lastActivity,
      duration: Date.now() - session.startTime,
      context: session.context,
      connected: session.aiClient.connected
    };
  }

  /**
   * ==========================================
   * Get Active AI Sessions
   * ==========================================
   */
  getActiveAISessions() {
    const sessions = [];
    
    for (const [callSid, session] of this.activeAISessions.entries()) {
      sessions.push({
        callSid,
        startTime: session.startTime,
        duration: Date.now() - session.startTime,
        context: session.context,
        connected: session.aiClient.connected
      });
    }

    return sessions;
  }

  /**
   * ==========================================
   * Cleanup Stale AI Sessions
   * ==========================================
   */
  async cleanupStaleSessions() {
    const now = Date.now();
    const staleThreshold = 30 * 60 * 1000; // 30 minutes

    for (const [callSid, session] of this.activeAISessions.entries()) {
      if (now - session.lastActivity > staleThreshold) {
        logger.warn(`🧹 Cleaning stale AI session: ${callSid}`);
        await this.endAISession(callSid);
      }
    }
  }

  /**
   * ==========================================
   * Handle AI Service Health Issues
   * ==========================================
   */
  async handleAIServiceHealthIssue() {
    try {
      logger.warn('⚠️ AI service health issue detected');

      // End all active AI sessions gracefully
      const activeSessions = Array.from(this.activeAISessions.keys());
      
      for (const callSid of activeSessions) {
        try {
          // Update call state to indicate AI unavailable
          await callStateService.updateCallState(callSid, {
            aiAssistant: {
              active: false,
              unavailable: true,
              endTime: new Date()
            }
          });

          await this.endAISession(callSid);
          
          // Could trigger alternative routing here
          logger.info(`🔄 Rerouted call ${callSid} due to AI service issues`);
          
        } catch (error) {
          logger.error(`Failed to handle AI service issue for ${callSid}:`, error);
        }
      }

    } catch (error) {
      logger.error('Error handling AI service health issue:', error);
    }
  }

  /**
   * ==========================================
   * Get AI Service Statistics
   * ==========================================
   */
  getAIStats() {
    const activeSessions = this.getActiveAISessions();
    
    return {
      activeSessions: activeSessions.length,
      totalSessionsCreated: this.totalSessionsCreated || 0,
      averageSessionDuration: activeSessions.length > 0 
        ? activeSessions.reduce((sum, s) => sum + s.duration, 0) / activeSessions.length 
        : 0,
      fallbackTriggers: this.fallbackTriggers,
      serviceHealth: 'unknown' // Could be updated with health checks
    };
  }
}

export default new AIAssistantService();
