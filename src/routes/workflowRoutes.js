import express from 'express';
import IVRController from '../controllers/ivrController.js';
import pythonTTSService from '../services/pythonTTSService.js';
import ttsJobQueue from '../services/ttsJobQueue.js';
import ivrAnalyticsService from '../services/ivrAnalyticsService.js';
import ivrWorkflowEngine from '../services/ivrWorkflowEngine.js';
import Workflow from '../models/Workflow.js';
import { body, validationResult } from 'express-validator';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';
import IVRExecutionEngine from '../services/ivrExecutionEngine.js';
import { IndustryNodeHandlers } from '../services/industryNodeHandlers.js';
import workflowNodeService from '../services/workflowNodeService.js';
import { NODE_TYPES, NODE_CONFIGS } from '../config/workflowNodeConfig.js';
import { authenticate } from '../middleware/auth.js';
import twilio from 'twilio';
import { getSocketIO, getUserRoom } from '../sockets/unifiedSocket.js';
import { resolveUserTwilioContext } from '../middleware/userTwilioContext.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

const router = express.Router();
router.use(authenticate);
router.use(resolveUserTwilioContext);

const getAuthenticatedUserId = (req) => {
  const rawUserId = req.user?._id || req.user?.id || req.user?.sub || req.user?.userId;
  if (!rawUserId || !mongoose.Types.ObjectId.isValid(rawUserId)) {
    return null;
  }
  return new mongoose.Types.ObjectId(rawUserId);
};

/**
 * GET /api/workflow/nodes
 * Get all available node types and configurations
 */
router.get('/nodes', (req, res) => {
  try {
    const nodeTypes = workflowNodeService.getAllNodeTypes();
    res.json({
      success: true,
      data: nodeTypes
    });
  } catch (error) {
    logger.error('Error getting node types:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get node types'
    });
  }
});

/**
 * GET /api/workflow/nodes/:nodeType
 * Get configuration for a specific node type
 */
router.get('/nodes/:nodeType', (req, res) => {
  try {
    const { nodeType } = req.params;
    const schema = workflowNodeService.getNodeSchema(nodeType);

    if (!schema) {
      return res.status(404).json({
        success: false,
        error: 'Node type not found'
      });
    }

    res.json({
      success: true,
      data: schema
    });
  } catch (error) {
    logger.error('Error getting node schema:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get node schema'
    });
  }
});

/**
 * POST /api/workflow/nodes/validate
 * Validate node configuration
 */
router.post('/nodes/validate', [
  body('nodeType').notEmpty().withMessage('Node type is required'),
  body('nodeData').notEmpty().withMessage('Node data is required')
], (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { nodeType, nodeData } = req.body;
    const validation = workflowNodeService.validateNode(nodeType, nodeData);

    res.json({
      success: validation.isValid,
      errors: validation.errors,
      warnings: validation.warnings
    });
  } catch (error) {
    logger.error('Error validating node:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to validate node'
    });
  }
});

/**
 * POST /api/workflow/nodes/create
 * Create a new node
 */
router.post('/nodes/create', [
  body('nodeType').notEmpty().withMessage('Node type is required'),
  body('position.x').isNumeric().withMessage('Position X is required'),
  body('position.y').isNumeric().withMessage('Position Y is required')
], (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { nodeType, position, initialData } = req.body;
    const node = workflowNodeService.createNode(nodeType, position, initialData);

    res.json({
      success: true,
      data: node
    });
  } catch (error) {
    logger.error('Error creating node:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/workflow/nodes/:nodeId/execute
 * Execute a specific node (for testing)
 */
router.post('/nodes/:nodeId/execute', [
  body('nodeType').notEmpty().withMessage('Node type is required'),
  body('nodeData').notEmpty().withMessage('Node data is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { nodeId } = req.params;
    const { nodeType, nodeData, context } = req.body;

    const node = { id: nodeId, type: nodeType, data: nodeData };
    const workflow = { _id: 'test', settings: {}, nodes: [], edges: [] };

    const result = await workflowNodeService.executeNode(node, context || {}, workflow);

    res.json({
      success: result.success,
      data: result
    });
  } catch (error) {
    logger.error('Error executing node:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/workflow/templates
 * Get available node templates
 */
router.get('/templates', (req, res) => {
  try {
    const templates = {
      basicWelcome: {
        name: 'Basic Welcome',
        description: 'Simple welcome message with menu options',
        node: {
          type: NODE_TYPES.GREETING,
          data: {
            text: 'Welcome to our company. Press 1 for Sales, 2 for Support, or 3 for Billing.',
            menuOptions: [
              { digit: '1', text: 'Sales' },
              { digit: '2', text: 'Support' },
              { digit: '3', text: 'Billing' }
            ]
          }
        }
      },
      customerService: {
        name: 'Customer Service Flow',
        description: 'Complete customer service workflow',
        nodes: [
          {
            type: NODE_TYPES.GREETING,
            data: {
              text: 'Welcome to Customer Service. Press 1 for Account, 2 for Technical Support, or 3 to speak with an agent.',
              menuOptions: [
                { digit: '1', text: 'Account' },
                { digit: '2', text: 'Technical Support' },
                { digit: '3', text: 'Speak with Agent' }
              ]
            }
          },
          {
            type: NODE_TYPES.USER_INPUT,
            data: {
              text: 'Please enter your account number.',
              inputType: 'digits',
              numDigits: 8
            }
          },
          {
            type: NODE_TYPES.CONDITIONAL,
            data: {
              variable: 'caller_input',
              operator: 'equals',
              value: '3'
            }
          },
          {
            type: NODE_TYPES.TRANSFER,
            data: {
              destination: '+1234567890',
              announceText: 'Transferring you to an agent now.'
            }
          }
        ]
      },
      aiAssistant: {
        name: 'AI Assistant Flow',
        description: 'Workflow with AI assistant integration',
        nodes: [
          {
            type: NODE_TYPES.GREETING,
            data: {
              text: 'Welcome! Press 1 to speak with our AI assistant or 2 for traditional support.',
              menuOptions: [
                { digit: '1', text: 'AI Assistant' },
                { digit: '2', text: 'Traditional Support' }
              ]
            }
          },
          {
            type: NODE_TYPES.CONDITIONAL,
            data: {
              variable: 'caller_input',
              operator: 'equals',
              value: '1'
            }
          },
          {
            type: NODE_TYPES.AI_ASSISTANT,
            data: {
              streamUrl: 'ws://localhost:4000/ws',
              welcomeMessage: 'Connecting you to our AI assistant...',
              maxDuration: 300
            }
          }
        ]
      }
    };

    res.json({
      success: true,
      data: templates
    });
  } catch (error) {
    logger.error('Error getting templates:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get templates'
    });
  }
});

/**
 * GET /api/workflow/test
 * Test route to verify workflow routes are working
 */
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Workflow routes are working',
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /api/workflow/generate-audio
 * Generate audio for all nodes in a workflow
 */
router.post('/generate-audio', authenticate, [
  body('workflowId').isMongoId().withMessage('Valid workflow ID is required'),
  body('forceRegenerate').optional().isBoolean().withMessage('forceRegenerate must be boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { workflowId, forceRegenerate = false } = req.body;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Find the workflow using the Workflow model
    const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId });
    if (!workflow) {
      return res.status(404).json({
        success: false,
        error: 'Workflow not found'
      });
    }

    // Generate audio for all nodes
    const updatedWorkflow = await pythonTTSService.populateWorkflowAudio(workflow, forceRegenerate, workflowId);

    res.json({
      success: true,
      data: updatedWorkflow
    });
  } catch (error) {
    logger.error('Error generating workflow audio:', {
      message: error.message,
      code: error.code,
      failedNodes: error.failedNodes
    });

    const statusCode = error.code === 'AUDIO_GENERATION_FAILED' ? 400 : 500;
    const errorMessage = error.code === 'AUDIO_GENERATION_FAILED'
      ? `Audio generation failed: ${error.message}`
      : 'Failed to generate workflow audio';

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      code: error.code,
      failedNodes: error.failedNodes
    });
  }
});

/**
 * GET /api/workflow/:workflowId
 * Get workflow configuration with nodes and edges
 */
router.get('/:workflowId', authenticate, async (req, res) => {
  try {
    const { workflowId } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId });
    if (!workflow) {
      return res.status(404).json({
        success: false,
        error: 'Workflow not found'
      });
    }

    // Extract nodes and edges from workflow, ensure they exist
    const nodes = workflow.nodes || [];
    const edges = workflow.edges || [];

    // Return the complete workflow data with nodes and edges
    res.json({
      success: true,
      data: {
        _id: workflow._id,
        promptKey: workflow.promptKey,
        displayName: workflow.displayName,
        status: workflow.status,
        ttsStatus: workflow.ttsStatus,
        nodes: nodes,
        edges: edges,
        config: workflow.config || {},
        tags: workflow.tags || []
      }
    });
  } catch (error) {
    logger.error('Error getting workflow:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get workflow'
    });
  }
});

/**
 * GET /api/workflow/:workflowId/refresh
 * Get fresh workflow data with latest audio URLs (after TTS completion)
 */
router.get('/:workflowId/refresh', authenticate, async (req, res) => {
  try {
    const { workflowId } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId });
    if (!workflow) {
      return res.status(404).json({
        success: false,
        error: 'Workflow not found'
      });
    }

    // Extract nodes and edges from workflow
    const nodes = workflow.nodes || [];
    const edges = workflow.edges || [];

    // Check which nodes have audio URLs
    const nodesWithAudio = nodes.filter(n => n.data?.audioUrl || n.audioUrl).map(n => ({
      id: n.id,
      type: n.type,
      audioUrl: n.data?.audioUrl || n.audioUrl,
      audioAssetId: n.data?.audioAssetId || n.audioAssetId
    }));

    const nodesWithoutAudio = nodes.filter(n => !(n.data?.audioUrl || n.audioUrl)).map(n => ({
      id: n.id,
      type: n.type,
      hasText: !!(n.data?.text || n.data?.message || n.data?.messageText || n.data?.prompt)
    }));

    res.json({
      success: true,
      data: {
        _id: workflow._id,
        promptKey: workflow.promptKey,
        displayName: workflow.displayName,
        status: workflow.status,
        ttsStatus: workflow.ttsStatus,
        nodes: nodes,
        edges: edges,
        config: workflow.config || {},
        tags: workflow.tags || [],
        audioStatus: {
          totalNodes: nodes.length,
          nodesWithAudio: nodesWithAudio.length,
          nodesWithoutAudio: nodesWithoutAudio.length,
          audioReady: nodesWithAudio.length > 0,
          allAudioReady: nodesWithoutAudio.length === 0,
          audioUrls: nodesWithAudio,
          pendingNodes: nodesWithoutAudio
        }
      }
    });
  } catch (error) {
    logger.error('Error refreshing workflow:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh workflow'
    });
  }
});


/**
 * PUT /api/workflow/:workflowId
 * Update workflow configuration and generate audio
 */
router.put('/:workflowId', authenticate, [
  body('nodes').isArray().withMessage('Nodes must be an array'),
  body('edges').isArray().withMessage('Edges must be an array')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { workflowId } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { nodes = [], edges = [] } = req.body;

    console.log('🔄 PUT /api/workflow/:id - Updating workflow:', {
      workflowId,
      nodesCount: nodes.length,
      edgesCount: edges.length,
      nodesSample: nodes.slice(0, 2),
      edgesSample: edges.slice(0, 2)
    });

    const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId });
    if (!workflow) {
      console.error('❌ Workflow not found:', workflowId);
      return res.status(404).json({
        success: false,
        error: 'Workflow not found'
      });
    }

    console.log('✅ Found workflow:', {
      id: workflow._id,
      promptKey: workflow.promptKey,
      currentNodesCount: workflow.nodes?.length || 0,
      currentEdgesCount: workflow.edges?.length || 0
    });

    // Use unified IVRWorkflowEngine for core update logic
    const updateResult = await ivrWorkflowEngine.updateWorkflow(workflowId, {
      nodes,
      edges,
      settings: req.body.settings || req.body.config || {}
    });

    // Get the TTS job ID if one was created
    const ttsJobId = updateResult.ttsJobId || null;
    const nodesNeedingAudio = updateResult.nodesNeedingAudio || [];

    // Emit socket event for real-time frontend updates
    const io = getSocketIO();
    if (io) {
      io.to(getUserRoom(userId)).emit('workflow_updated', {
        workflowId: updateResult._id,
        workflowData: {
          _id: updateResult._id,
          promptKey: updateResult.promptKey,
          displayName: updateResult.displayName,
          nodes: updateResult.nodes,
          edges: updateResult.edges,
          config: updateResult.config,
          status: updateResult.status,
          tags: updateResult.tags,
          updatedAt: updateResult.updatedAt,
          ttsStatus: nodesNeedingAudio.length > 0 ? 'processing' : 'completed'
        },
        timestamp: new Date().toISOString()
      });
      logger.info(`📡 Socket.IO emitted: workflow_updated for workflow ${workflowId}`);
    }

    res.json({
      success: true,
      data: {
        workflow: updateResult,
        audioProcessing: {
          status: nodesNeedingAudio.length > 0 ? 'queued' : 'completed',
          nodesToProcess: nodesNeedingAudio.length,
          jobId: ttsJobId,
          message: nodesNeedingAudio.length > 0 
            ? 'Audio generation is in progress. Use the jobId to track status or listen for Socket.IO events.'
            : 'All audio already generated.'
        }
      }
    });

  } catch (error) {
    console.error('❌ PUT /api/workflow/:id - Error updating workflow:', {
      message: error.message,
      stack: error.stack,
      workflowId: req.params.workflowId,
      body: req.body
    });

    logger.error('Error updating workflow:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update workflow'
    });
  }
});

/**
 * GET /api/workflow/:workflowId/tts-status/:jobId
 * Get TTS job status with detailed error information
 */
router.get('/:workflowId/tts-status/:jobId', authenticate, async (req, res) => {
  try {
    const { workflowId, jobId } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const job = ttsJobQueue.getJobStatus(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    if (job.workflowId !== workflowId) {
      return res.status(403).json({
        success: false,
        error: 'Job does not belong to this workflow'
      });
    }

    // Get fresh workflow data to show current audio URLs
    const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId });
    const nodesWithAudio = [];
    const nodesWithoutAudio = [];
    
    if (workflow && workflow.nodes) {
      for (const node of workflow.nodes) {
        const hasAudio = !!(node.data?.audioUrl || node.audioUrl);
        const nodeInfo = {
          id: node.id,
          type: node.type,
          hasAudio: hasAudio,
          audioUrl: node.data?.audioUrl || node.audioUrl || null
        };
        
        if (hasAudio) {
          nodesWithAudio.push(nodeInfo);
        } else {
          nodesWithoutAudio.push(nodeInfo);
        }
      }
    }

    res.json({
      success: true,
      data: {
        jobId: job.id,
        status: job.status,
        progress: job.progress || 0,
        processedNodes: job.processedNodes,
        totalNodes: job.totalNodes,
        remainingNodes: job.remainingNodes || 0,
        duration: job.duration || 0,
        errors: job.errors || [],
        error: job.error || null,
        retries: job.retries || 0,
        createdAt: job.createdAt,
        startedAt: job.startTime,
        completedAt: job.endTime,
        // Current workflow audio status
        workflowAudioStatus: {
          totalNodes: workflow?.nodes?.length || 0,
          nodesWithAudio: nodesWithAudio.length,
          nodesWithoutAudio: nodesWithoutAudio.length,
          audioReady: nodesWithAudio.length > 0,
          allAudioReady: nodesWithoutAudio.length === 0,
          nodes: nodesWithAudio
        }
      }
    });
  } catch (error) {
    logger.error('Error getting TTS job status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get job status'
    });
  }
});


/**
 * POST /api/workflow/:workflowId/tts-retry/:jobId
 * Retry a failed TTS job
 */
router.post('/:workflowId/tts-retry/:jobId', authenticate, async (req, res) => {
  try {
    const { workflowId, jobId } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId }).select('_id');
    if (!workflow) {
      return res.status(404).json({ success: false, error: 'Workflow not found' });
    }

    const job = ttsJobQueue.getJobStatus(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    if (job.workflowId !== workflowId) {
      return res.status(403).json({
        success: false,
        error: 'Job does not belong to this workflow'
      });
    }

    // Retry the job
    const newJobId = await ttsJobQueue.retryJob(jobId);

    res.json({
      success: true,
      data: {
        message: 'TTS job retry initiated',
        oldJobId: jobId,
        newJobId: newJobId,
        status: 'pending',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Error retrying TTS job:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to retry job'
    });
  }
});

/**
 * GET /api/workflow/tts-queue-stats
 * Get TTS queue statistics (admin endpoint)
 */
router.get('/tts-queue-stats', authenticate, async (req, res) => {
  try {
    const stats = ttsJobQueue.getQueueStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Error getting TTS queue stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get queue statistics'
    });
  }
});


/**
 * PUT /api/workflow/:workflowId/status
 * Update workflow status (active/inactive)
 */
router.put('/:workflowId/status', authenticate, [
  body('status').isIn(['active', 'inactive']).withMessage('Status must be active or inactive')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { workflowId } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { status } = req.body;

    const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId });
    if (!workflow) {
      return res.status(404).json({
        success: false,
        error: 'Workflow not found'
      });
    }

    // Update workflow status
    workflow.status = status;

    await workflow.save();

    logger.info(`Workflow ${workflowId} status updated to ${status}`);

    res.json({
      success: true,
      data: {
        workflowId,
        status,
        updatedAt: workflow.updatedAt
      }
    });
  } catch (error) {
    logger.error('Error updating workflow status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update workflow status'
    });
  }
});

/**
 * GET /api/workflow/:workflowId/status
 * Get workflow status
 */
router.get('/:workflowId/status', authenticate, async (req, res) => {
  try {
    const { workflowId } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId }).select('status updatedAt');
    if (!workflow) {
      return res.status(404).json({
        success: false,
        error: 'Workflow not found'
      });
    }

    res.json({
      success: true,
      data: {
        workflowId,
        status: workflow.status,
        updatedAt: workflow.updatedAt
      }
    });
  } catch (error) {
    logger.error('Error getting workflow status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get workflow status'
    });
  }
});

/**
 * DELETE /api/workflow/:workflowId
 * Delete workflow and all associated audio files
 */
router.delete('/:workflowId', authenticate, async (req, res) => {
  try {
    const { workflowId } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId }).select('_id');
    if (!workflow) {
      return res.status(404).json({
        success: false,
        error: 'Workflow not found'
      });
    }

    // Use ivrWorkflowEngine to delete workflow and clean up audio files
    const result = await ivrWorkflowEngine.deleteWorkflow(workflowId);

    res.json({
      success: true,
      data: {
        workflowId,
        deleted: true,
        deletedNodes: result.deletedNodes,
        message: `Workflow ${workflowId} and ${result.deletedNodes} associated audio files deleted successfully`
      }
    });
  } catch (error) {
    logger.error('Error deleting workflow:', error);
    
    if (error.message === 'Workflow not found') {
      return res.status(404).json({
        success: false,
        error: 'Workflow not found'
      });
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete workflow'
    });
  }
});

/**
 * POST /ivr/workflow/:workflowId
 * Execute a workflow node and return TwiML
 */

router.post('/workflow/:workflowId', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { Digits, SpeechResult } = req.body;
    const { CallSid } = req.body;

    logger.info(`Executing workflow ${workflowId} for call ${CallSid}`);

    // Check if workflow is active before executing
    const workflow = await Workflow.findById(workflowId);
    if (!workflow) {
      logger.error(`Workflow ${workflowId} not found`);
      const response = new VoiceResponse();
      response.say({ voice: 'alice' }, 'We apologize, but this service is currently unavailable.');
      response.hangup();
      res.type('text/xml');
      return res.send(response.toString());
    }

    if (workflow.status !== 'active') {
      logger.warn(`Workflow ${workflowId} is not active (status: ${workflow.status})`);
      const response = new VoiceResponse();
      response.say({ voice: 'alice' }, 'We apologize, but this service is currently unavailable.');
      response.hangup();
      res.type('text/xml');
      return res.send(response.toString());
    }

    // Determine user input
    const userInput = Digits || SpeechResult || null;

    // Get call context (in production, use Redis/session store)
    const context = await _getCallContext(CallSid);

    // Execute workflow
    const twiml = await IVRExecutionEngine.executeWorkflow(
      workflowId,
      userInput,
      CallSid,
      context
    );

    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    logger.error('Workflow execution error:', error);
    res.type('text/xml');
    res.send(_createErrorResponse());
  }
});

/**
 * POST /ivr/workflow/:workflowId/node/:nodeId
 * Execute a specific node (for direct navigation)
 */
router.post('/workflow/:workflowId/node/:nodeId', async (req, res) => {
  try {
    const { workflowId, nodeId } = req.params;
    const { CallSid } = req.body;

    const workflow = await Workflow.findById(workflowId);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    const node = workflow.nodes.find(n => n.id === nodeId);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const context = await _getCallContext(CallSid);
    context.currentNodeId = nodeId;

    const twiml = await IVRExecutionEngine.executeWorkflow(
      workflowId,
      null,
      CallSid,
      context
    );

    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    logger.error('Node execution error:', error);
    res.type('text/xml');
    res.send(_createErrorResponse());
  }
});

/**
 * POST /ivr/hotel/booking
 * Handle hotel booking requests
 */
router.post('/hotel/booking', async (req, res) => {
  try {
    const { SpeechResult, CallSid } = req.body;

    // Parse booking information from speech
    const bookingInfo = await _parseBookingInfo(SpeechResult);

    // In production, integrate with hotel booking system
    logger.info(`Hotel booking request for call ${CallSid}:`, bookingInfo);

    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, `I understand you want to book ${bookingInfo.guests} guests from ${bookingInfo.checkIn} to ${bookingInfo.checkOut}. Is this correct?`);

    response.gather({
      input: 'speech',
      timeout: 5,
      action: '/ivr/hotel/confirm_booking',
      method: 'POST'
    });

    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Hotel booking error:', error);
    res.type('text/xml');
    res.send(_createErrorResponse());
  }
});

/**
 * POST /ivr/insurance/claims
 * Handle insurance claims
 */
router.post('/insurance/claims', async (req, res) => {
  try {
    const { SpeechResult, CallSid } = req.body;

    // Process claim information
    const claimInfo = await _parseClaimInfo(SpeechResult);

    logger.info(`Insurance claim for call ${CallSid}:`, claimInfo);

    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, 'Thank you for providing your claim information. Our claims department will review it and contact you within 24 hours. Is there anything else I can help you with?');

    response.gather({
      input: 'speech',
      timeout: 5,
      action: '/ivr/main_menu',
      method: 'POST'
    });

    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Insurance claims error:', error);
    res.type('text/xml');
    res.send(_createErrorResponse());
  }
});

/**
 * POST /ivr/healthcare/appointment
 * Handle healthcare appointments
 */
router.post('/healthcare/appointment', async (req, res) => {
  try {
    const { SpeechResult, CallSid } = req.body;

    const appointmentInfo = await _parseAppointmentInfo(SpeechResult);

    logger.info(`Healthcare appointment for call ${CallSid}:`, appointmentInfo);

    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, `I have your appointment request for ${appointmentInfo.dateTime} in the ${appointmentInfo.department} department. We will send a confirmation SMS. Is there anything else you need?`);

    response.gather({
      input: 'speech',
      timeout: 5,
      action: '/ivr/main_menu',
      method: 'POST'
    });

    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Healthcare appointment error:', error);
    res.type('text/xml');
    res.send(_createErrorResponse());
  }
});

/**
 * POST /ivr/retail/product_lookup
 * Handle retail product inquiries
 */
router.post('/retail/product_lookup', async (req, res) => {
  try {
    const { SpeechResult, CallSid } = req.body;

    const productInfo = await _parseProductInfo(SpeechResult);

    logger.info(`Retail product inquiry for call ${CallSid}:`, productInfo);

    // In production, integrate with product catalog
    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, `${productInfo.product} is currently ${productInfo.availability}. The price is ${productInfo.price}. Would you like to place an order?`);

    response.gather({
      input: 'speech',
      timeout: 5,
      action: '/ivr/retail/order',
      method: 'POST'
    });

    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Retail product lookup error:', error);
    res.type('text/xml');
    res.send(_createErrorResponse());
  }
});

/**
 * POST /ivr/ai/assistant
 * Handle AI assistant interactions
 */
router.post('/ai/assistant', async (req, res) => {
  try {
    const { SpeechResult, CallSid } = req.body;

    // In production, integrate with AI service
    const aiResponse = await _getAIResponse(SpeechResult);

    logger.info(`AI assistant interaction for call ${CallSid}:`, { input: SpeechResult, response: aiResponse });

    const response = new VoiceResponse();
    response.say({ voice: 'alice' }, aiResponse);

    response.gather({
      input: 'speech',
      timeout: 15,
      action: '/ivr/ai/assistant',
      method: 'POST'
    });

    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('AI assistant error:', error);
    res.type('text/xml');
    res.send(_createErrorResponse());
  }
});

/**
 * GET /ivr/workflows/health
 * Health check for workflow service
 */
router.get('/workflows/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      executionEngine: 'active',
      industryHandlers: Object.keys(IndustryNodeHandlers).length
    }
  });
});

/**
 * Helper functions
 */
async function _getCallContext(callSid) {
  // In production, use Redis or proper session store
  // For now, return empty context
  return {};
}

function _createErrorResponse() {
  const response = new VoiceResponse();
  response.say({ voice: 'alice' }, 'We apologize, but our service is temporarily unavailable. Please try again later.');
  response.hangup();
  return response.toString();
}

async function _parseBookingInfo(speech) {
  // Simple parsing - in production, use NLP service
  return {
    checkIn: 'tomorrow',
    checkOut: 'in 3 days',
    guests: 2
  };
}

async function _parseClaimInfo(speech) {
  return {
    policyNumber: 'POL123456',
    claimType: 'auto',
    description: speech
  };
}

async function _parseAppointmentInfo(speech) {
  return {
    department: 'general',
    dateTime: 'tomorrow at 10 AM'
  };
}

async function _parseProductInfo(speech) {
  return {
    product: 'iPhone 15',
    availability: 'in stock',
    price: '$999'
  };
}

async function _getAIResponse(input) {
  // In production, integrate with AI service
  const responses = [
    'I understand your request. Let me help you with that.',
    'That\'s a great question. Here\'s what I can tell you.',
    'Based on what you\'ve told me, I recommend the following.'
  ];

  return responses[Math.floor(Math.random() * responses.length)];
}

export default router;
