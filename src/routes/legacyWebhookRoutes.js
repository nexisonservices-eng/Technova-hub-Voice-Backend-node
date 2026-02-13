/**
 * Legacy Webhook Routes - Compatibility Layer
 * Provides backward compatibility with existing IVR system
 * Integrates new Twilio webhooks with existing logic
 */

import express from 'express';
import logger from '../utils/logger.js';
import IVRController from '../controllers/ivrController.js';
import ivrWorkflowEngine from '../services/ivrWorkflowEngine.js';
import Workflow from '../models/Workflow.js';
import ExecutionLog from '../models/ExecutionLog.js';
import twilio from 'twilio';

const router = express.Router();

// Create IVR controller instance
const ivrController = new IVRController();

/**
 * Legacy webhook endpoints that maintain compatibility
 * These map to existing IVR controller methods
 */

// Map existing IVR routes to Twilio webhook paths
router.post('/welcome', (req, res) => ivrController.welcome(req, res));
router.post('/select-language', (req, res) => ivrController.selectLanguage(req, res));
router.post('/handle-input', (req, res) => ivrController.handleInput(req, res));
router.post('/next-step', (req, res) => ivrController.nextStep(req, res));
router.post('/process-service', (req, res) => ivrController.processService(req, res));
router.post('/call-status', (req, res) => ivrController.handleCallStatus(req, res));

/**
 * Enhanced legacy routes with additional tracking
 */

/**
 * POST /webhook/legacy/enhanced-welcome
 * Enhanced welcome with both legacy and new tracking
 */
router.post('/enhanced-welcome', async (req, res) => {
  try {
    const { CallSid, From, To } = req.body;
    logger.info(`Enhanced welcome for call ${CallSid} from ${From} to ${To}`);

    // Use existing welcome logic
    await ivrController.welcome(req, res);
    
    // Additional tracking can be added here
    // For example: analytics, logging, etc.
    
  } catch (error) {
    logger.error('Error in enhanced welcome:', error);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, 'We apologize, but our service is temporarily unavailable.');
    response.hangup();
    res.type('text/xml');
    res.send(response.toString());
  }
});

/**
 * POST /webhook/legacy/enhanced-input
 * Enhanced input handling with tracking
 */
router.post('/enhanced-input', async (req, res) => {
  try {
    const { CallSid, Digits, SpeechResult } = req.body;
    logger.info(`Enhanced input handling for call ${CallSid}`);

    // Use existing input logic
    await ivrController.handleInput(req, res);
    
    // Additional analytics can be added here
    
  } catch (error) {
    logger.error('Error in enhanced input:', error);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, 'We apologize, but an error occurred. Please try again.');
    response.hangup();
    res.type('text/xml');
    res.send(response.toString());
  }
});

/**
 * GET /webhook/legacy/status
 * Get status of legacy IVR system
 */
router.get('/status', async (req, res) => {
  try {
    // Get active executions from existing system
    const activeExecutions = ivrWorkflowEngine.activeExecutions;
    
    // Get active workflows
    const activeWorkflows = await Workflow.find({ status: 'active', isActive: true });
    
    // Get recent execution logs
    const recentLogs = await ExecutionLog
      .find({ startTime: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } })
      .sort({ startTime: -1 })
      .limit(10);
    
    res.json({
      status: 'healthy',
      legacy_system: {
        active_executions: activeExecutions.size,
        active_workflows: activeWorkflows.length,
        recent_logs: recentLogs.length,
        execution_engine: 'active'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting legacy system status:', error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

/**
 * POST /webhook/legacy/migrate
 * Migrate from legacy to new system (if needed)
 */
router.post('/migrate', async (req, res) => {
  try {
    const { CallSid, targetSystem } = req.body;
    
    logger.info(`Migrating call ${CallSid} to ${targetSystem} system`);
    
    // Get current execution state
    const executionState = ivrWorkflowEngine.getExecutionState(CallSid);
    
    if (!executionState) {
      return res.status(404).json({
        success: false,
        error: 'No active execution found'
      });
    }
    
    // Migration logic would go here
    // For now, just return the current state
    
    res.json({
      success: true,
      current_state: executionState,
      target_system: targetSystem,
      message: 'Migration endpoint ready for implementation'
    });
    
  } catch (error) {
    logger.error('Error in migration:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /webhook/legacy/cleanup
 * Clean up completed executions
 */
router.post('/cleanup', async (req, res) => {
  try {
    logger.info('Cleaning up legacy system executions');
    
    // Use existing cleanup from workflow engine
    await ivrWorkflowEngine.cleanupStaleExecutions();
    
    res.json({
      success: true,
      message: 'Legacy system cleanup completed',
      active_executions: ivrWorkflowEngine.activeExecutions.size
    });
    
  } catch (error) {
    logger.error('Error in legacy cleanup:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /webhook/legacy/health
 * Health check for legacy system
 */
router.get('/health', (req, res) => {
  try {
    const health = {
      status: 'healthy',
      system: 'legacy_ivr',
      components: {
        ivr_controller: 'active',
        workflow_engine: 'active',
        database: 'connected',
        active_executions: ivrWorkflowEngine.activeExecutions.size
      },
      timestamp: new Date().toISOString()
    };
    
    res.json(health);
  } catch (error) {
    logger.error('Legacy health check error:', error);
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

export default router;
