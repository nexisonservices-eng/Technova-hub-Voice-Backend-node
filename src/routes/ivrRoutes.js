import express from 'express';
import IVRController from '../controllers/ivrController.js';
import pythonTTSService from '../services/pythonTTSService.js';
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
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';
import { resolveUserTwilioContext } from '../middleware/userTwilioContext.js';
import twilio from 'twilio';
import { deleteFromCloudinary } from '../utils/cloudinaryUtils.js';

import IVRAudioController from '../controllers/IVRAudioController.js';

const router = express.Router();

// Create IVR controller instance
const ivrController = new IVRController();

const getAuthenticatedUserId = (req) => {
  const rawUserId = req.user?._id || req.user?.id || req.user?.sub || req.user?.userId;
  if (!rawUserId || !mongoose.Types.ObjectId.isValid(rawUserId)) {
    return null;
  }
  return new mongoose.Types.ObjectId(rawUserId);
};

// Twilio webhook endpoints
router.post('/welcome', verifyTwilioRequest, (req, res) => ivrController.welcome(req, res));
router.post('/select-language', verifyTwilioRequest, (req, res) => ivrController.selectLanguage(req, res));
router.post('/handle-input', verifyTwilioRequest, (req, res) => ivrController.handleInput(req, res));
router.post('/next-step', verifyTwilioRequest, (req, res) => ivrController.nextStep(req, res));
router.post('/process-service', verifyTwilioRequest, (req, res) => ivrController.processService(req, res));
router.post('/call-status', verifyTwilioRequest, (req, res) => ivrController.handleCallStatus(req, res));

// Multer configuration for audio uploads
import multer from 'multer';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

/**
 * POST /ivr/audio/upload
 * Upload audio file for IVR nodes
 */
router.post('/audio/upload', authenticate, upload.single('audio'), (req, res) => IVRAudioController.upload(req, res));

/**
 * DELETE /ivr/audio/:publicId
 * Delete custom uploaded audio file (handles Cloudinary paths with forward slashes)
 */
router.delete('/audio/:publicId', authenticate, (req, res) => {
  // Only handle if publicId contains forward slashes (Cloudinary path)
  const publicId = decodeURIComponent(req.params.publicId);
  if (publicId.includes('/')) {
    console.log('Deleting custom audio:', publicId);
    return IVRAudioController.delete(req, res);
  } else {
    // Let TTS route handle simple promptKey/language format
    return res.status(404).json({ success: false, error: 'Not found' });
  }
});

/**
 * POST /ivr/tts/preview
 * Generate audio for TTS preview
 */
router.post('/tts/preview', authenticate, (req, res) => IVRAudioController.ttsPreview(req, res));

// Apply authentication for all management endpoints below
router.use(authenticate);
router.use(resolveUserTwilioContext);

// Management endpoints for audio generation and management

/**
 * DELETE /ivr/audio/:promptKey/:language
 * Delete audio for specific prompt and language
 */


/**
 * GET /ivr/prompts
 * Get all IVR prompts with their audio files
 */
router.get('/prompts', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const prompts = await Workflow.find({ isActive: true, createdBy: userId })
      .select('promptKey displayName nodes edges config status tags createdAt updatedAt')
      .sort({ promptKey: 1 });

    res.json({
      success: true,
      prompts,
      total: prompts.length
    });
  } catch (error) {
    logger.error('Failed to get prompts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /ivr/prompts/:promptKey
 * Get specific prompt details
 */
router.get('/prompts/:promptKey', async (req, res) => {
  try {
    const { promptKey } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const prompt = await Workflow.findOne({ promptKey, isActive: true, createdBy: userId });

    if (!prompt) {
      return res.status(404).json({
        success: false,
        error: 'Prompt not found'
      });
    }

    res.json({
      success: true,
      data: prompt
    });
  } catch (error) {
    logger.error('Failed to get prompt:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve prompt'
    });
  }
});

/**
 * POST /ivr/generate-audio
 * Generate audio for a specific prompt and language
 */
router.post('/generate-audio', [
  body('promptKey').notEmpty().withMessage('Prompt key is required'),
  body('text').notEmpty().withMessage('Text is required'),
  body('language').isIn(['en-GB', 'ta-IN', 'hi-IN']).withMessage('Invalid language code'),
  body('forceRegenerate').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { promptKey, text, language, forceRegenerate = false } = req.body;
    const prompt = await Workflow.findOne({ promptKey, createdBy: userId, isActive: true }).select('_id');
    if (!prompt) {
      return res.status(404).json({ success: false, error: 'Prompt not found' });
    }

    logger.info(`Generating audio for prompt: ${promptKey}, language: ${language}`);

    const audioUrl = await pythonTTSService.getAudioForPrompt(
      promptKey,
      text,
      language,
      forceRegenerate
    );

    res.json({
      success: true,
      data: {
        promptKey,
        language,
        audioUrl,
        text,
        forceRegenerate
      }
    });
  } catch (error) {
    logger.error('Failed to generate audio:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /ivr/generate-all-languages
 * Generate audio for all supported languages
 */
router.post('/generate-all-languages', [
  body('promptKey').notEmpty().withMessage('Prompt key is required'),
  body('text').notEmpty().withMessage('Text is required'),
  body('forceRegenerate').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { promptKey, text, forceRegenerate = false } = req.body;
    const prompt = await Workflow.findOne({ promptKey, createdBy: userId, isActive: true }).select('_id');
    if (!prompt) {
      return res.status(404).json({ success: false, error: 'Prompt not found' });
    }

    logger.info(`Generating audio for all languages for prompt: ${promptKey}`);

    const results = await pythonTTSService.generateAudioForAllLanguages(
      promptKey,
      text,
      forceRegenerate
    );

    res.json({
      success: true,
      data: {
        promptKey,
        text,
        results,
        forceRegenerate
      }
    });
  } catch (error) {
    logger.error('Failed to generate audio for all languages:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /ivr/audio/:promptKey/:language
 * Delete audio for specific prompt and language
 */
router.delete('/audio/:promptKey/:language', async (req, res) => {
  
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { promptKey, language } = req.params;
    const prompt = await Workflow.findOne({ promptKey, createdBy: userId, isActive: true }).select('_id');
    if (!prompt) {
      return res.status(404).json({ success: false, error: 'Prompt not found' });
    }

    if (!['en-GB', 'ta-IN', 'hi-IN'].includes(language)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid language code'
      });
    }

    logger.info(`Deleting audio for prompt: ${promptKey}, language: ${language}`);

    await pythonTTSService.deleteAudio(promptKey, language);

    res.json({
      success: true,
      message: 'Audio deleted successfully'
    });
  } catch (error) {
    logger.error('Failed to delete audio:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /ivr/languages
 * Get supported languages
 */
router.get('/languages', (req, res) => {
  try {
    const languages = pythonTTSService.getSupportedLanguages();

    res.json({
      success: true,
      data: Object.entries(languages).map(([code, info]) => ({
        code,
        name: info.name,
        voice: info.voice
      }))
    });
  } catch (error) {
    logger.error('Failed to get languages:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve supported languages'
    });
  }
});

/**
 * POST /ivr/create-menu-prompt
 * Create a new menu-type IVR prompt
 */
router.post('/create-menu-prompt', [
  body('promptKey').notEmpty().withMessage('Prompt key is required'),
  body('text').notEmpty().withMessage('Text is required'),
  body('options').isArray().withMessage('Options must be an array'),
  body('options.*.digit').notEmpty().withMessage('Each option must have a digit'),
  body('options.*.action').notEmpty().withMessage('Each option must have an action')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { promptKey, text, options, tags = [] } = req.body;

    // Check if prompt already exists
    const existingPrompt = await Workflow.findOne({ promptKey, createdBy: userId });
    if (existingPrompt) {
      return res.status(409).json({
        success: false,
        error: 'Prompt already exists'
      });
    }

    // Create new workflow prompt
    const newPrompt = new Workflow({
      promptKey,
      displayName: promptKey,
      nodes: [],
      edges: [],
      config: {
        type: 'menu',
        options
      },
      tags,
      isActive: true,
      createdBy: userId,
      lastModifiedBy: userId
    });

    await newPrompt.save();

    logger.info(`Created new menu prompt: ${promptKey}`);

    res.status(201).json({
      success: true,
      data: newPrompt
    });
  } catch (error) {
    logger.error('Failed to create menu prompt:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /ivr/prompts/:promptKey
 * Update existing prompt
 */
router.put('/prompts/:promptKey', [
  body('text').optional().notEmpty().withMessage('Text cannot be empty'),
  body('isActive').optional().isBoolean(),
  body('tags').optional().isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { promptKey } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const updates = req.body;

    const prompt = await Workflow.findOne({ promptKey, createdBy: userId });
    if (!prompt) {
      return res.status(404).json({
        success: false,
        error: 'Prompt not found'
      });
    }

    // Update fields
    Object.keys(updates).forEach(key => {
      if (key === 'menuConfig') {
        prompt.menuConfig = { ...prompt.menuConfig, ...updates[key] };
      } else {
        prompt[key] = updates[key];
      }
    });

    prompt.updatedAt = new Date();
    await prompt.save();

    logger.info(`Updated prompt: ${promptKey}`);

    res.json({
      success: true,
      data: prompt
    });
  } catch (error) {
    logger.error('Failed to update prompt:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /ivr/stats
 * Get IVR usage statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const stats = await Workflow.aggregate([
      { $match: { isActive: true, createdBy: userId } },
      {
        $group: {
          _id: '$status',
          totalWorkflows: { $sum: 1 },
          avgNodeCount: { $avg: { $size: { $ifNull: ['$nodes', []] } } },
          avgEdgeCount: { $avg: { $size: { $ifNull: ['$edges', []] } } },
          lastUpdated: { $max: '$updatedAt' }
        }
      },
      {
        $project: {
          _id: 0,
          stats: {
            totalWorkflows: '$totalWorkflows',
            avgNodeCount: '$avgNodeCount',
            avgEdgeCount: '$avgEdgeCount',
            lastUpdated: '$lastUpdated'
          }
        }
      }
    ]);

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    logger.error('Failed to get IVR stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get IVR stats'
    });
  }
});

/**
 * POST /ivr/batch-generate
 * Batch generate audio for multiple prompts
 */
router.post('/batch-generate', [
  body('prompts').isArray().withMessage('Prompts must be an array'),
  body('prompts.*.promptKey').notEmpty().withMessage('Each prompt needs a key'),
  body('prompts.*.text').notEmpty().withMessage('Each prompt needs text'),
  body('prompts.*.languages').isArray().withMessage('Each prompt needs languages array'),
  body('forceRegenerate').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { prompts, forceRegenerate = false } = req.body;
    const results = [];

    logger.info(`Starting batch generation for ${prompts.length} prompts`);

    for (const prompt of prompts) {
      try {
        const promptDoc = await Workflow.findOne({
          promptKey: prompt.promptKey,
          createdBy: userId,
          isActive: true
        }).select('_id');

        if (!promptDoc) {
          results.push({
            promptKey: prompt.promptKey,
            results: { error: 'Prompt not found' }
          });
          continue;
        }

        const promptResults = {};

        for (const language of prompt.languages) {
          try {
            const audioUrl = await pythonTTSService.getAudioForPrompt(
              prompt.promptKey,
              prompt.text,
              language,
              forceRegenerate
            );
            promptResults[language] = { success: true, audioUrl };
          } catch (error) {
            promptResults[language] = { success: false, error: error.message };
          }
        }

        results.push({
          promptKey: prompt.promptKey,
          results: promptResults
        });

      } catch (error) {
        results.push({
          promptKey: prompt.promptKey,
          results: { error: error.message }
        });
      }
    }

    logger.info(`Batch generation completed for ${prompts.length} prompts`);

    res.json({
      success: true,
      data: {
        totalPrompts: prompts.length,
        results
      }
    });
  } catch (error) {
    logger.error('Failed to batch generate:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /ivr/python-health
 * Check Python TTS service health
 */
router.get('/python-health', async (req, res) => {
  try {
    const health = await pythonTTSService.checkPythonServiceHealth();

    res.json({
      success: true,
      data: health
    });
  } catch (error) {
    logger.error('Failed to check Python service health:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /ivr/voices/:language
 * Get available voices for a language from Python service
 */
router.get('/voices/:language', async (req, res) => {
  try {
    const { language } = req.params;
    const voices = await pythonTTSService.getAvailableVoices(language);

    res.json({
      success: true,
      data: voices
    });
  } catch (error) {
    logger.error('Failed to get voices:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /ivr/menus
 * Get all IVR menus (alias for prompts endpoint)
 */
router.get('/menus', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Get total count
    const total = await Workflow.countDocuments({ isActive: true, createdBy: userId });

    const menus = await Workflow.find({ isActive: true, createdBy: userId })
      .select('promptKey displayName nodes edges config status tags createdAt updatedAt')
      .sort({ promptKey: 1 })
      .skip(skip)
      .limit(limit);

    const formattedMenus = menus.map(menu => {
      const greetingNode = menu.nodes.find(node => node.type === 'greeting');
      const inputNodes = menu.nodes.filter(node => node.type === 'input');

      return {
        _id: menu._id,
        promptKey: menu.promptKey,
        displayName: menu.displayName,
        greeting: {
          text: greetingNode?.data?.text || 'Welcome',
          voice: menu.config?.voiceId || 'en-GB-SoniaNeural',
          language: menu.config?.language || 'en-GB'
        },
        menuOptions: inputNodes.map(node => ({
          digit: node.data?.digit || '1',
          label: node.data?.label || 'Option',
          action: node.data?.action || 'transfer',
          destination: node.data?.destination || ''
        })),
        settings: {
          timeout: menu.config?.timeout || 10,
          maxAttempts: menu.config?.maxAttempts || 3,
          invalidInputMessage: menu.config?.invalidInputMessage || 'Invalid selection. Please try again.'
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

    res.json({
      success: true,
      ivrMenus: formattedMenus,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error) {
    logger.error('Failed to get IVR menus:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve IVR menus'
    });
  }
});

/**
 * GET /ivr/menus/:id
 * Get specific IVR menu by ID
 */
router.get('/menus/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    let query = {};
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { _id: id };
    } else {
      query = { promptKey: id };
    }

    const menu = await Workflow.findOne({ ...query, isActive: true, createdBy: userId });

    if (!menu) {
      return res.status(404).json({
        success: false,
        error: 'IVR menu not found'
      });
    }

    const audioFile = menu.audioFiles && menu.audioFiles.length > 0
      ? menu.audioFiles[menu.audioFiles.length - 1]
      : null;

    res.json({
      success: true,
      ivrMenu: {
        _id: menu._id,
        ivrName: menu.promptKey,
        greeting: {
          text: menu.text,
          audioUrl: audioFile?.audioUrl || null,
          audioAssetId: audioFile?.cloudinaryPublicId || null,
          voice: audioFile?.language || 'Unknown'
        },
        menuOptions: (menu.menuConfig?.options || []).map(opt => ({
          _id: opt._id,
          digit: opt.digit,
          label: opt.label || opt.action,
          action: opt.action,
          destination: opt.target || opt.destination || ''
        })),
        settings: {
          timeout: menu.menuConfig?.inputValidation?.timeout || 10,
          maxAttempts: menu.menuConfig?.inputValidation?.maxAttempts || 3,
          invalidInputMessage: menu.menuConfig?.inputValidation?.invalidInputMessage || "Invalid option. Please try again."
        },
        status: menu.isActive ? 'active' : 'inactive',
        tags: menu.tags || [],
        createdAt: menu.createdAt,
        updatedAt: menu.updatedAt
      }
    });
  } catch (error) {
    logger.error('Failed to get IVR menu:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve IVR menu'
    });
  }
});

/**
 * POST /ivr/menus
 * Create new IVR menu
 */
router.post('/menus', [
  body('name').notEmpty().withMessage('Menu name is required'),
  body('greeting').notEmpty().withMessage('Greeting text is required'),
  body('menu').isArray().withMessage('Menu options must be an array')
], async (req, res) => {
  try {
    console.log('POST /menus request body:', req.body);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { name, greeting, menu, tags = [] } = req.body;

    // Check if menu already exists
    const existingMenu = await Workflow.findOne({ promptKey: name, createdBy: userId });
    if (existingMenu) {
      return res.status(409).json({
        success: false,
        error: 'IVR menu already exists'
      });
    }

    // Create new workflow menu
    const newMenu = new Workflow({
      promptKey: name,
      displayName: name,
      nodes: [],
      edges: [],
      config: {
        type: 'menu',
        options: menu
      },
      tags,
      isActive: true,
      createdBy: userId,
      lastModifiedBy: userId
    });

    // Generate audio for all nodes
    const updatedWorkflow = await pythonTTSService.populateWorkflowAudio(newMenu, true);

    // Save updated workflow
    await updatedWorkflow.save();

    logger.info(`Created new IVR menu: ${name}`);

    // Get greeting audio for response
    const audioFile = updatedWorkflow.audioFiles && updatedWorkflow.audioFiles.length > 0
      ? updatedWorkflow.audioFiles[updatedWorkflow.audioFiles.length - 1]
      : null;

    res.status(201).json({
      success: true,
      ivrMenu: {
        _id: updatedWorkflow._id,
        ivrName: updatedWorkflow.promptKey,
        greeting: {
          text: updatedWorkflow.text,
          audioUrl: audioFile?.audioUrl || null,
          audioAssetId: audioFile?.cloudinaryPublicId || null,
          voice: audioFile?.language || 'Unknown'
        },
        menuOptions: (updatedWorkflow.menuConfig?.options || []).map(opt => ({
          _id: opt._id,
          digit: opt.digit,
          label: opt.label || opt.action,
          action: opt.action,
          destination: opt.target || opt.destination || ''
        })),
        settings: {
          timeout: updatedWorkflow.menuConfig?.inputValidation?.timeout || 10,
          maxAttempts: updatedWorkflow.menuConfig?.inputValidation?.maxAttempts || 3,
          invalidInputMessage: updatedWorkflow.menuConfig?.inputValidation?.invalidInputMessage || "Invalid option. Please try again."
        },
        workflowConfig: updatedWorkflow.workflowConfig,
        status: updatedWorkflow.isActive ? 'active' : 'inactive',
        tags: updatedWorkflow.tags || [],
        createdAt: updatedWorkflow.createdAt,
        updatedAt: updatedWorkflow.updatedAt
      }
    });
  } catch (error) {
    logger.error('Failed to create IVR menu:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /ivr/menus/:id
 * Update existing IVR menu
 */
router.put('/menus/:id', [
  body('name').optional().notEmpty().withMessage('Menu name cannot be empty'),
  body('greeting').optional().notEmpty().withMessage('Greeting cannot be empty'),
  body('menu').optional().isArray().withMessage('Menu options must be an array'),
  body('tags').optional().isArray(),
  body('voiceId').optional().notEmpty().withMessage('Voice ID cannot be empty')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const updates = req.body;
    const { voiceId } = updates;

    let query = {};
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { _id: id };
    } else {
      query = { promptKey: id };
    }

    const menu = await Workflow.findOne({ ...query, createdBy: userId });
    if (!menu) {
      return res.status(404).json({
        success: false,
        error: 'IVR menu not found'
      });
    }

    // Update fields
    if (updates.name && updates.name !== id) {
      // Update promptKey if name changed
      menu.promptKey = updates.name;
    }
    if (updates.greeting) {
      menu.text = updates.greeting;
    }
    if (updates.menu) {
      menu.menuConfig = {
        ...menu.menuConfig,
        type: 'menu',
        options: updates.menu
      };
    }
    if (updates.tags) {
      menu.tags = updates.tags;
    }

    // Auto-generate audio for entire workflow
    await pythonTTSService.populateWorkflowAudio(menu, !!voiceId); // Force regenerate if voiceId changed

    // Save final state
    menu.updatedAt = new Date();
    await menu.save();

    // Get the latest audio file for greeting
    const audioFile = menu.audioFiles && menu.audioFiles.length > 0
      ? menu.audioFiles[menu.audioFiles.length - 1]
      : null;
    const audioUrl = audioFile?.audioUrl || null;
    const audioAssetId = audioFile?.cloudinaryPublicId || null;
    const voiceLanguage = audioFile?.language || 'Unknown';

    res.json({
      success: true,
      message: 'IVR menu updated and audio generated successfully',
      ivrMenu: {
        _id: menu._id,
        ivrName: menu.promptKey,
        greeting: {
          text: menu.text,
          audioUrl,
          audioAssetId,
          voice: voiceLanguage
        },
        menuOptions: (menu.menuConfig?.options || []).map(opt => ({
          _id: opt._id,
          digit: opt.digit,
          label: opt.label || opt.action,
          action: opt.action,
          destination: opt.target || opt.destination || ''
        })),
        settings: {
          timeout: menu.menuConfig?.inputValidation?.timeout || 10,
          maxAttempts: menu.menuConfig?.inputValidation?.maxAttempts || 3,
          invalidInputMessage: menu.menuConfig?.inputValidation?.invalidInputMessage || "Invalid option. Please try again."
        },
        workflowConfig: {
          ...menu.workflowConfig,
          nodes: menu.workflowConfig?.nodes?.map(node => ({
            ...node,
            audioUrl: node.audioUrl || menu.greeting?.audioUrl || null,
            audioAssetId: node.audioAssetId || menu.greeting?.audioAssetId || null,
            data: {
              ...node.data,
              audioUrl: node.data?.audioUrl || node.audioUrl || menu.greeting?.audioUrl || null,
              audioAssetId: node.data?.audioAssetId || node.audioAssetId || menu.greeting?.audioAssetId || null
            }
          })) || []
        },
        status: menu.isActive ? 'active' : 'inactive',
        tags: menu.tags || [],
        createdAt: menu.createdAt,
        updatedAt: menu.updatedAt
      }
    });
  } catch (error) {
    logger.error('Failed to update IVR menu:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /ivr/menus/:id
 * Delete IVR menu
 */
router.delete('/menus/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    let query = {};
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { _id: id };
    } else {
      query = { promptKey: id };
    }

    const menu = await Workflow.findOne({ ...query, createdBy: userId });
    if (!menu) {
      return res.status(404).json({
        success: false,
        error: 'IVR menu not found'
      });
    }

    // Collect Cloudinary publicIds from legacy + current workflow structures
    const publicIds = new Set();

    // New workflow shape
    (menu.nodes || []).forEach((node) => {
      const nodeData = node?.data || {};
      const nodeLevelIds = [node.audioAssetId, node.cloudinaryPublicId, node.publicId];
      const dataLevelIds = [nodeData.audioAssetId, nodeData.cloudinaryPublicId, nodeData.publicId];
      [...nodeLevelIds, ...dataLevelIds]
        .filter((pid) => typeof pid === 'string' && pid.trim())
        .forEach((pid) => publicIds.add(pid.trim()));
    });

    // Legacy fields
    (menu.audioFiles || []).forEach((file) => {
      [file?.audioAssetId, file?.cloudinaryPublicId, file?.publicId]
        .filter((pid) => typeof pid === 'string' && pid.trim())
        .forEach((pid) => publicIds.add(pid.trim()));
    });

    // Delete assets from Cloudinary (best-effort, do not block DB delete)
    const assetDeleteErrors = [];
    for (const publicId of publicIds) {
      try {
        await deleteFromCloudinary(publicId);
      } catch (err) {
        logger.warn(`Failed to delete Cloudinary asset for IVR ${id}: ${publicId}`, err);
        assetDeleteErrors.push({ publicId, error: err.message });
      }
    }

    // Hard delete from MongoDB
    await Workflow.deleteOne({ _id: menu._id });

    logger.info(`Deleted IVR menu: ${id}`);

    res.json({
      success: true,
      message: 'IVR menu deleted successfully',
      deleted: {
        workflowId: menu._id,
        cloudinaryAssetsRequested: publicIds.size,
        cloudinaryDeleteErrors: assetDeleteErrors
      }
    });
  } catch (error) {
    logger.error('Failed to delete IVR menu:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /ivr/menus/:id/test
 * Test IVR menu
 */
router.post('/menus/:id/test', async (req, res) => {
  try {
    const { id } = req.params;
    const { callSid, phoneNumber } = req.body;
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    let menu = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      menu = await Workflow.findOne({ _id: id, isActive: true, createdBy: userId });
    }
    if (!menu) {
      menu = await Workflow.findOne({ promptKey: id, isActive: true, createdBy: userId });
    }
    if (!menu) {
      return res.status(404).json({
        success: false,
        error: 'IVR menu not found'
      });
    }

    // Generate test TwiML for the menu
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say({
      voice: 'alice',
      language: 'en-US'
    }, menu.text);

    // Add menu options if available
    if (menu.menuConfig?.options && menu.menuConfig.options.length > 0) {
      const gather = response.gather({
        numDigits: 1,
        timeout: 10,
        action: `/webhook/ivr/selection/${callSid || 'test'}`,
        method: 'POST'
      });

      menu.menuConfig.options.forEach(option => {
        gather.say({
          voice: 'alice',
          language: 'en-US'
        }, `For ${option.action || option.text}, press ${option.digit}.`);
      });
    }

    logger.info(`Tested IVR menu: ${id}`);

    res.json({
      success: true,
      message: 'IVR menu test completed',
      result: {
        menuId: id,
        twiml: response.toString(),
        greeting: menu.text,
        options: menu.menuConfig?.options || []
      }
    });
  } catch (error) {
    logger.error('Failed to test IVR menu:', error);
    res.status(500).json({
      success: false,
    });
  } // Close catch
}); // Close router.post

/**
 * GET /ivr/active-calls
 * Get currently active executions
 */
router.get('/active-calls', async (req, res) => {
  try {
    const activeCalls = await ivrAnalyticsService.getActiveCalls();
    res.json({ success: true, data: activeCalls });
  } catch (error) {
    logger.error('Failed to get active calls:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /ivr/analytics/workflow/:workflowId
 * Get analytics for a specific workflow
 */
router.get('/analytics/workflow/:workflowId', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { startDate, endDate } = req.query;
    const stats = await ivrAnalyticsService.getWorkflowStats(workflowId, startDate, endDate);
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get workflow stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /ivr/analytics/nodes/:workflowId
 * Get node-level analytics (heatmap)
 */
router.get('/analytics/nodes/:workflowId', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const stats = await ivrAnalyticsService.getNodeAnalytics(workflowId);
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get node stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /ivr/executions/:workflowId
 * Get recent executions
 */
router.get('/executions/:workflowId', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const executions = await ivrAnalyticsService.getRecentExecutions(workflowId, limit);
    res.json({ success: true, data: executions });
  } catch (error) {
    logger.error('Failed to get recent executions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /ivr/executions/details/:callSid
 * Get execution details
 */
router.get('/executions/details/:callSid', async (req, res) => {
  try {
    const { callSid } = req.params;
    const details = await ivrAnalyticsService.getExecutionDetails(callSid);
    res.json({ success: true, data: details });
  } catch (error) {
    logger.error('Failed to get execution details:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /ivr/executions/:callSid/stop
 * Force stop an execution
 */
router.post('/executions/:callSid/stop', async (req, res) => {
  try {
    const { callSid } = req.params;
    const { reason } = req.body;
    await ivrWorkflowEngine.endExecution(callSid, reason || 'manual_stop');
    res.json({ success: true, message: 'Execution stopped' });
  } catch (error) {
    logger.error('Failed to stop execution:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /ivr/workflow/generate-audio
 * Batch generate audio for an entire IVR workflow JSON
 */
router.post('/workflow/generate-audio', async (req, res) => {
  try {
    const workflow = req.body;
    const { forceRegenerate = false } = req.query;
    const updatedWorkflow = await pythonTTSService.populateWorkflowAudio(
      workflow,
      forceRegenerate === 'true' || forceRegenerate === true
    );
    const generatedFiles = (updatedWorkflow.nodes || [])
      .map((node) => ({
        nodeId: node.id,
        nodeType: node.type,
        audioUrl: node?.data?.audioUrl || node.audioUrl || null
      }))
      .filter((entry) => Boolean(entry.audioUrl));

    res.json({
      success: true,
      message: `Successfully generated ${generatedFiles.length} audio files`,
      ivrMenu: updatedWorkflow,
      generatedFiles
    });

  } catch (error) {
    logger.error('Batch workflow generation failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
