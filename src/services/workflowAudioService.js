import axios from 'axios';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import cloudinary from "../utils/cloudinaryUtils.js";

const PYTHON_TTS_URL = process.env.PYTHON_TTS_URL || 'http://localhost:4000';
const AUDIO_CACHE_TTL = 86400000; // 24 hours in milliseconds

/**
 * Workflow Audio Service
 * Handles TTS generation and caching for IVR workflows
 * Uses exact same logic as broadcastService.generateSingleAudio()
 */
class WorkflowAudioService {
  constructor() {
    this.audioCache = new Map(); // In-memory cache
    this.processingQueue = new Map(); // Prevent duplicate requests
  }

  normalizeServiceUrl(url = '') {
    return String(url).trim().replace(/\/+$/, '');
  }

  getTtsServiceUrls() {
    const candidates = [
      process.env.AI_SERVICE_HTTP,
      process.env.PYTHON_TTS_URL,
      process.env.PYTHON_TTS_SERVICE_URL,
      PYTHON_TTS_URL
    ]
      .map((url) => this.normalizeServiceUrl(url))
      .filter(Boolean);

    return [...new Set(candidates)];
  }

  async postTtsWithFailover(payload) {
    const urls = this.getTtsServiceUrls();
    const failures = [];

    for (const serviceUrl of urls) {
      try {
        logger.info(`Trying TTS endpoint: ${serviceUrl}/tts/broadcast`);
        const response = await axios.post(
          `${serviceUrl}/tts/broadcast`,
          payload,
          {
            responseType: 'arraybuffer',
            timeout: 30000
          }
        );
        return response;
      } catch (error) {
        failures.push({
          url: serviceUrl,
          code: error.code,
          message: error.message
        });

        logger.warn(`TTS endpoint failed: ${serviceUrl}`, {
          code: error.code,
          message: error.message
        });
      }
    }

    const summary = failures
      .map((f) => `${f.url} [${f.code || 'ERR'}: ${f.message}]`)
      .join(' | ');

    const ttsError = new Error(`All TTS endpoints failed. ${summary}`);
    ttsError.code = 'TTS_ENDPOINTS_UNAVAILABLE';
    ttsError.failures = failures;
    throw ttsError;
  }

  getLanguageFromVoice(voiceId = '') {
    // Expected format: en-GB-SoniaNeural, ta-IN-PallaviNeural, etc.
    const parts = String(voiceId).split('-');
    if (parts.length >= 2) {
      return `${parts[0]}-${parts[1]}`;
    }
    return 'en-GB';
  }

  /**
   * Generate TTS audio using exact same logic as broadcastService
   * @param {string} text - Text to convert to speech
   * @param {string} voiceId - Voice ID for TTS
   * @param {string} language - Language code
   * @returns {Promise<{audioUrl: string, audioAssetId: string}>}
   */
  async generateSingleAudio(text, voiceId, language) {
    try {
      logger.info(`Generating TTS: voice=${voiceId}, lang=${language}, text length=${text.length}`);

      // Create message object exactly like broadcastService
      const message = {
        text: text,
        uniqueKey: crypto.createHash('md5').update(text).digest('hex')
      };

      // Create voice object exactly like broadcastService
      const voice = {
        voiceId: voiceId,
        provider: 'edge',
        language: language
      };

      const ttsResponse = await this.postTtsWithFailover({
        text: message.text,
        voice: voice.voiceId,
        provider: voice.provider,
        language: voice.language
      });

      // Upload to Cloudinary (exact same as broadcastService)
      const audioBuffer = Buffer.from(ttsResponse.data);

      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'video',
            folder: process.env.CLOUDINARY_IVR_AUDIO_FOLDER || 'ivr-audio',
            public_id: message.uniqueKey
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(audioBuffer);
      });

      return {
        uniqueKey: message.uniqueKey,
        text: message.text,
        audioUrl: uploadResult.secure_url,
        audioAssetId: uploadResult.public_id,
        duration: Math.ceil(message.text.split(' ').length / 2.5) // Estimate
      };
    } catch (error) {
      logger.error(`Failed to generate audio for text: ${text}`, error);
      throw error;
    }
  }

  /**
   * Get or generate audio for text
   * @param {String} text - Text to convert to speech
   * @param {String} voice - Voice ID (e.g., 'ta-IN-PallaviNeural')
   * @param {String} workflowId - Workflow ID for caching
   * @param {String} nodeId - Node ID for caching
   * @returns {Promise<Object>} Audio URL and asset ID
   */
  async getOrGenerateAudio(text, voice, workflowId, nodeId) {
    try {
      // Generate cache key
      const cacheKey = this.generateCacheKey(text, voice);

      // Check in-memory cache first
      if (this.audioCache.has(cacheKey)) {
        const cached = this.audioCache.get(cacheKey);

        // Check if cache is still valid
        if (Date.now() - cached.timestamp < AUDIO_CACHE_TTL) {
          logger.debug('Audio retrieved from cache', { cacheKey });
          return {
            audioUrl: cached.audioUrl,
            audioAssetId: cached.audioAssetId,
          };
        } else {
          // Cache expired
          this.audioCache.delete(cacheKey);
        }
      }

      // Check if already processing this request
      if (this.processingQueue.has(cacheKey)) {
        logger.debug('Audio generation in progress, waiting...', { cacheKey });
        return this.processingQueue.get(cacheKey);
      }

      // Start new generation
      const language = this.getLanguageFromVoice(voice);
      const generationPromise = this.generateSingleAudio(text, voice, language);
      this.processingQueue.set(cacheKey, generationPromise);

      try {
        const result = await generationPromise;

        // Cache the result
        this.audioCache.set(cacheKey, {
          audioUrl: result.audioUrl,
          audioAssetId: result.audioAssetId,
          timestamp: Date.now(),
        });

        logger.info('Audio generated and cached', {
          cacheKey,
          audioUrl: result.audioUrl,
        });

        return result;
      } finally {
        // Remove from processing queue
        this.processingQueue.delete(cacheKey);
      }
    } catch (error) {
      logger.error('Failed to get or generate audio', {
        text: text?.substring(0, 50),
        voice,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Pre-generate audio for entire workflow
   * @param {Object} workflow - IVR workflow object
   * @returns {Promise<Object>} Updated workflow with audio URLs
   */
  async preGenerateWorkflowAudio(workflow) {
    try {
      logger.info('Pre-generating audio for workflow', {
        workflowId: workflow._id,
        nodeCount: workflow.nodes?.length || 0,
      });

      const nodes = workflow.nodes || [];
      const settings = workflow.config || {};
      const itemsToGenerate = [];

      // Collect all texts that need audio ONLY from audio and greeting nodes
      nodes.forEach((node) => {
        const { data } = node;

        // Process only audio nodes and greeting nodes (for backward compatibility)
        if ((node.type === 'audio' || node.type === 'greeting') && (data.messageText || data.text) && !data.audioUrl) {
          itemsToGenerate.push({
            text: data.messageText || data.text,
            voice: data.voice || settings.voiceId || 'ta-IN-PallaviNeural',
            language: data.language || settings.language || 'ta-IN',
            workflowId: workflow._id.toString(),
            nodeId: node.id,
          });
        }
      });

      if (itemsToGenerate.length === 0) {
        logger.info('No audio to generate', { workflowId: workflow._id });
        return workflow;
      }

      logger.info('Generating audio for nodes', {
        workflowId: workflow._id,
        count: itemsToGenerate.length,
      });

      // Generate audio for all items
      for (const item of itemsToGenerate) {
        try {
          const result = await this.getOrGenerateAudio(
            item.text,
            item.voice,
            item.workflowId,
            item.nodeId
          );

          // Find and update node
          const node = nodes.find((n) => n.id === item.nodeId);
          if (node) {
            node.data.audioUrl = result.audioUrl;
            node.data.audioAssetId = result.audioAssetId;
            // Also update node-level fields
            node.audioUrl = result.audioUrl;
            node.audioAssetId = result.audioAssetId;
          }
        } catch (error) {
          logger.error('Failed to generate audio for node', {
            nodeId: item.nodeId,
            error: error.message,
          });
        }
      }

      // Also update greeting if it exists
      if (workflow.greeting?.text && !workflow.greeting.audioUrl) {
        const greetingResult = await this.getOrGenerateAudio(
          workflow.greeting.text,
          workflow.greeting.voice || 'ta-IN-PallaviNeural',
          workflow._id.toString(),
          'greeting'
        );

        workflow.greeting.audioUrl = greetingResult.audioUrl;
        workflow.greeting.audioAssetId = greetingResult.audioAssetId;
      }

      logger.info('Workflow audio pre-generation complete', {
        workflowId: workflow._id,
        processed: itemsToGenerate.length,
      });

      return workflow;
    } catch (error) {
      logger.error('Workflow audio pre-generation failed', {
        workflowId: workflow._id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate cache key from text and voice
   * @param {String} text - Text content
   * @param {String} voice - Voice ID
   * @returns {String} Cache key
   */
  generateCacheKey(text, voice) {
    const hash = crypto
      .createHash('md5')
      .update(`${text}:${voice}`)
      .digest('hex');
    return `ivr_${hash}`;
  }

  /**
   * Clear audio cache
   * @param {String} cacheKey - Optional specific key to clear
   */
  clearCache(cacheKey = null) {
    if (cacheKey) {
      this.audioCache.delete(cacheKey);
      logger.info('Cache key cleared', { cacheKey });
    } else {
      this.audioCache.clear();
      logger.info('Audio cache cleared completely');
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    const now = Date.now();
    let validCount = 0;
    let expiredCount = 0;

    this.audioCache.forEach((value) => {
      if (now - value.timestamp < AUDIO_CACHE_TTL) {
        validCount++;
      } else {
        expiredCount++;
      }
    });

    return {
      total: this.audioCache.size,
      valid: validCount,
      expired: expiredCount,
      processingQueue: this.processingQueue.size,
    };
  }

  /**
   * Clean expired cache entries
   */
  cleanExpiredCache() {
    const now = Date.now();
    let cleaned = 0;

    this.audioCache.forEach((value, key) => {
      if (now - value.timestamp >= AUDIO_CACHE_TTL) {
        this.audioCache.delete(key);
        cleaned++;
      }
    });

    if (cleaned > 0) {
      logger.info('Cleaned expired cache entries', { count: cleaned });
    }

    return cleaned;
  }
}

// Create singleton instance
const workflowAudioService = new WorkflowAudioService();

// Schedule cache cleanup every hour
setInterval(() => {
  workflowAudioService.cleanExpiredCache();
}, 3600000);

export default workflowAudioService;
