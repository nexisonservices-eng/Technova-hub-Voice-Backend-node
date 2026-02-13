import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import cloudinary from 'cloudinary';
import logger from '../utils/logger.js';

class PythonTTSService {
  constructor() {
    this.pythonServiceUrl =
      process.env.AI_SERVICE_HTTP ||
      process.env.PYTHON_TTS_SERVICE_URL ||
      'http://localhost:4000';

    // Edge TTS free tier only supports these voices (now synced with Python service)
    this.allowedVoices = [
      'en-GB-SoniaNeural',
      'en-GB-RyanNeural',
      'en-GB-LibbyNeural',
      'en-GB-ThomasNeural',
      'ta-IN-PallaviNeural',
      'ta-IN-ValluvarNeural',
      'hi-IN-SwaraNeural',
      'hi-IN-MadhurNeural'
    ];

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    this.languageMappings = {
      'en-US': { voice: 'en-GB-SoniaNeural' },
      'en-GB': { voice: 'en-GB-SoniaNeural' },
      'ta-IN': { voice: 'ta-IN-PallaviNeural' },
      'hi-IN': { voice: 'hi-IN-SwaraNeural' }
    };

    // Voice to language mapping
    this.VOICE_LANGUAGE = {
      "English (GB) â€“ Female": "en-GB",
      "English (US) â€“ Female": "en-GB",
      "en-GB-SoniaNeural": "en-GB",
      "en-GB-RyanNeural": "en-GB",
      "en-GB-LibbyNeural": "en-GB",
      "en-GB-ThomasNeural": "en-GB",
      "ta-IN-ValluvarNeural": "ta-IN",
      "ta-IN-PallaviNeural": "ta-IN",
      "hi-IN-SwaraNeural": "hi-IN",
      "hi-IN-MadhurNeural": "hi-IN"
    };

    this.tempDir = path.join(process.cwd(), 'temp', 'tts');
    if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
  }

  generateTextHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  async getAvailableVoices() {
    try {
      const response = await axios.get(`${this.pythonServiceUrl}/tts/voices`);
      logger.info('ðŸ” Available voices from Python service:', response.data);
      
      // Extract voices array from response (Python returns {voices: [...], count: N})
      const voices = response.data?.voices || response.data || [];
      
      logger.info(`ðŸ” Extracted voices type: ${typeof voices}, isArray: ${Array.isArray(voices)}, length: ${voices?.length || 'N/A'}`);
      logger.info(`ðŸ” Full voices object:`, JSON.stringify(voices, null, 2));
      
      if (!Array.isArray(voices)) {
        logger.error('âŒ Invalid voices response from Python service:', response.data);
        return this.allowedVoices; // Use allowed voices as fallback
      }
      
      return voices;
    } catch (error) {
      logger.error('âŒ Failed to get available voices:', error.message);
      return this.allowedVoices;
    }
  }

  async generateSpeech(text, language = 'en-GB', voiceOverride) {
    const startTime = Date.now();
    
    // Check if Python service is accessible first
    try {
      await axios.get(`${this.pythonServiceUrl}/health`, { timeout: 5000 });
    } catch (healthError) {
      throw new Error(`Python TTS service not accessible at ${this.pythonServiceUrl}: ${healthError.message}`);
    }
    
    // Get available voices from Python service
    const availableVoices = await this.getAvailableVoices();
    
    // Extract the actual voices array from Python response
    const extractedVoices = availableVoices.voices || availableVoices;
    
    logger.info(`ðŸ” Available voices type: ${typeof extractedVoices}, isArray: ${Array.isArray(extractedVoices)}, length: ${extractedVoices?.length || 'N/A'}`);
    logger.info(`ðŸ” First few voices:`, JSON.stringify(extractedVoices.slice(0, 3), null, 2));
    
    let voice =
      voiceOverride ||
      this.languageMappings[language]?.voice ||
      'en-GB-SoniaNeural';

    const payload = { text, voice, language };
    
    logger.info(`ðŸŽ™ TTS Request Details:`, {
      text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
      voice: voice,
      language: language,
      payloadSize: JSON.stringify(payload).length
    });

    try {
      const response = await axios.post(
        `${this.pythonServiceUrl}/tts/broadcast`,
        payload,
        { responseType: 'arraybuffer', timeout: 60000 } // Back to arraybuffer for binary audio
      );

      const audioBuffer = Buffer.from(response.data || []);
      logger.info(`âœ… TTS completed in ${Date.now() - startTime}ms (${audioBuffer.length} bytes)`);
      if (!audioBuffer.length) {
        throw new Error(`TTS returned empty audio buffer for voice=${voice}, language=${language}`);
      }
      return audioBuffer; // Direct buffer access for binary response
    } catch (error) {
      // Retry once for timeout errors
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        logger.warn(`âš ï¸ TTS timeout, retrying once for voice=${voice}, language=${language}`);
        try {
          const retryResponse = await axios.post(
            `${this.pythonServiceUrl}/tts/broadcast`,
            payload,
            { responseType: 'arraybuffer', timeout: 90000 }
          );
          
          const retryBuffer = Buffer.from(retryResponse.data || []);
          logger.info(`âœ… TTS retry completed in ${Date.now() - startTime}ms (${retryBuffer.length} bytes)`);
          if (!retryBuffer.length) {
            throw new Error(`TTS retry returned empty audio buffer for voice=${voice}, language=${language}`);
          }
          return retryBuffer;
        } catch (retryError) {
          logger.error(`âŒ TTS retry failed for voice=${voice}, language=${language}:`, retryError.message);
          throw retryError;
        }
      } else {
        logger.error(`âŒ TTS failed for voice=${voice}, language=${language}:`, {
          message: error.message,
          status: error.response?.status,
          data: error.response?.data,
          stack: error.stack,
          code: error.code
        });
        
        // Try to parse error response if it's JSON
        if (error.response?.data) {
          try {
            const errorData = JSON.parse(error.response.data.toString());
            logger.error('âŒ Parsed TTS error:', errorData);
          } catch (e) {
            logger.error('âŒ Raw TTS error response:', error.response.data.toString());
          }
        }
        
        throw error;
      }
    }
  }

  async uploadToCloudinary(buffer, publicId, language) {
    return new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          resource_type: 'video',
          public_id: publicId,
          folder: 'ivr-audio',
          format: 'mp3',
          tags: ['ivr', language]
        },
        (err, result) => {
          if (err) return reject(err);
          resolve({
            audioUrl: result.secure_url,
            publicId: result.public_id,
            size: result.bytes || 0
          });
        }
      ).end(buffer);
    });
  }

  async getAudioForPrompt(promptKey, text, language = 'en-GB', voiceOverride, workflowId, node) {
  try {
    if (!text || !String(text).trim()) {
      throw new Error('Text is required to generate audio');
    }

    const nodeType = node?.type || 'prompt';
    const nodeId = node?.id || promptKey || 'default';

    const voice = voiceOverride || this.languageMappings[language]?.voice || 'en-GB-SoniaNeural';
    const requiredLanguage = this.VOICE_LANGUAGE[voice] || language || 'en-GB';

    const audioBuffer = await this.generateSpeech(text, requiredLanguage, voice);
    const publicId = `node_${nodeId}_${Date.now()}`;
    const upload = await this.uploadToCloudinary(audioBuffer, publicId, requiredLanguage);

    logger.info(`Audio generated for ${nodeType} (${nodeId}): ${upload.audioUrl}`);

    return {
      audioUrl: upload.audioUrl,
      publicId: upload.publicId,
      textHash: this.generateTextHash(text)
    };
  } catch (error) {
    logger.error(`Failed to generate audio for prompt ${promptKey}:`, error.message);
    throw error;
  }
}

  /**
   * ðŸ”¥ MAIN FIXED METHOD
   * Recursively generate audio for ALL IVR text
   */
  async populateWorkflowAudio(workflow, forceRegenerate = false, workflowId) {
    const workflowName = workflow.ivrName || workflow.name || workflow.promptKey || 'Unknown';
    logger.info(`ðŸŽ™ Generating audio for IVR: ${workflowName}`);

    // Initialize workflow structure  
    workflow.nodes = workflow.nodes || [];
    workflow.edges = workflow.edges || [];

    const processItem = async (item, id, type, defaultVoice) => {
      try {
        // Validate node before processing
        if (!item.type || !item.id) {
          throw new Error(`Node type or ID missing for ${type} (${id})`);
        }

        // Resolve node text in broadcast-style priority:
        // messageText -> message -> text (from data first, then top-level)
        let text;
        if (type === 'end') {
          text =
            item?.data?.messageText?.trim() ||
            item?.data?.message?.trim() ||
            item?.data?.text?.trim() ||
            item?.messageText?.trim() ||
            item?.message?.trim() ||
            item?.text?.trim();
          logger.info(
            `ðŸ”¤ End node text extraction: data.messageText="${item?.data?.messageText}", data.message="${item?.data?.message}", data.text="${item?.data?.text}", messageText="${item?.messageText}", message="${item?.message}", text="${item?.text}" -> "${text}"`
          );
        } else {
          text =
            item?.data?.messageText?.trim() ||
            item?.data?.message?.trim() ||
            item?.data?.text?.trim() ||
            item?.messageText?.trim() ||
            item?.message?.trim() ||
            item?.text?.trim();
          logger.info(
            `ðŸ”¤ ${type} node text extraction: data.messageText="${item?.data?.messageText}", data.message="${item?.data?.message}", data.text="${item?.data?.text}", messageText="${item?.messageText}", message="${item?.message}", text="${item?.text}" -> "${text}"`
          );
        }

        if (!text) {
          logger.warn(`âš ï¸ No text content found for node ${type} (${id}), skipping`);
          return;
        }

        // Check for promptKey in node data, generate if missing
        let promptKey = item.data?.promptKey;
        if (!promptKey || typeof promptKey !== "string") {
          // Generate unique promptKey with timestamp
          promptKey = `${type}_${id}_${Date.now()}`;
          logger.warn(
            `âš ï¸ Generated missing promptKey for node ${type} (${id}): ${promptKey}` 
          );
          
          // Update node data with generated promptKey
          if (item.data) {
            item.data.promptKey = promptKey;
          } else {
            item.data = { promptKey };
          }
        }

        let language = item.language || item?.data?.language || 'en-GB';
        let voice =
          item.voice ||
          item?.data?.voice ||
          defaultVoice ||
          'en-GB-SoniaNeural';

        // Language is already declared above

        // Log TTS payload for debugging
        logger.info('ðŸŽ™ TTS payload:', {
          text: text,
          voice: voice,
          promptKey: promptKey,
          nodeId: id,
          nodeType: type
        });

        // Validate language and match with voice using VOICE_LANGUAGE mapping
        const requiredLanguage = this.VOICE_LANGUAGE[voice];
        
        if (!requiredLanguage) {
          logger.error(`âŒ Unsupported voice: ${voice}. Falling back to en-GB-SoniaNeural`);
          const fallbackVoice = 'en-GB-SoniaNeural';
          const fallbackLanguage = this.VOICE_LANGUAGE[fallbackVoice];
          if (fallbackLanguage) {
            voice = fallbackVoice;
            language = fallbackLanguage;
            logger.info(`âœ… Using fallback voice: ${voice} with language: ${language}`);
          } else {
            throw new Error(`Both primary and fallback voices failed. Original: ${voice}`);
          }
        }
        
        if (language !== requiredLanguage) {
          logger.warn(
            `âš ï¸ Voice "${voice}" requires "${requiredLanguage}", overriding "${language}"` 
          );
          language = requiredLanguage;
        }

        if (!forceRegenerate && (item.audioUrl || item?.data?.audioUrl)) {
          logger.info(`ðŸŽµ Audio already exists for node ${type} (${id}), skipping`);
          return;
        }
        
        logger.info(`ðŸŽ™ Generating audio for node ${type} (${id}), promptKey: ${promptKey}`);
        
        try {
          const audioBuffer = await this.generateSpeech(text, language, voice);
          const publicId = `node_${id}_${Date.now()}`;

          const upload = await this.uploadToCloudinary(audioBuffer, publicId, language);

          // âœ… WRITE AUDIO EVERYWHERE
          item.audioUrl = upload.audioUrl;
          item.audioAssetId = upload.publicId;

          if (item.data) {
            item.data.audioUrl = upload.audioUrl;
            item.data.audioAssetId = upload.publicId;
            item.data.voice ??= voice;
            item.data.language ??= language;
            
            // For end nodes, ensure message field is preserved
            if (type === 'end') {
              if (!item.data.message) {
                item.data.message = text;
              }
            }
          }

          logger.info(`âœ… Audio generated: ${type} â†’ ${upload.audioUrl}`);
        } catch (ttsError) {
          logger.error(`âŒ TTS generation failed for ${type} (${id}):`, {
            message: ttsError.message,
            status: ttsError.response?.status,
            data: ttsError.response?.data,
            stack: ttsError.stack,
            code: ttsError.code
          });
          
          // Don't fail the entire workflow save, but mark node as failed
          item.audioStatus = "failed";
          item.audioError = ttsError.message;
          
          // Re-throw the REAL error, don't hide it
          throw ttsError;
        }
      } catch (error) {
        logger.error(`âŒ Failed to generate audio for ${type} item ${id}:`, {
          message: error.message,
          status: error.response?.status,
          data: error.response?.data,
          stack: error.stack,
          code: error.code
        });
        
        // Mark node as failed but don't fail entire process
        item.audioStatus = "failed";
        item.audioError = error.message;
        
        // Re-throw to propagate the error properly
        throw error;
      }
    };

    // Greeting
    if (workflow.greeting) {
      logger.info('ðŸ” Processing greeting:', JSON.stringify(workflow.greeting, null, 2));
      await processItem(
        workflow.greeting,
        'greeting',
        'greeting',
        workflow.config?.voiceId || workflow.settings?.voice
      );
    }

    // Menu options
    if (Array.isArray(workflow.menuOptions)) {
      logger.info('ðŸ” Processing menu options:', JSON.stringify(workflow.menuOptions, null, 2));
      for (const opt of workflow.menuOptions) {
        logger.info('ðŸ” Processing menu option:', JSON.stringify(opt, null, 2));
        await processItem(opt, opt._id || opt.digit, 'menu', workflow.config?.voiceId || workflow.settings?.voice);
      }
    }

    // Workflow nodes
    if (Array.isArray(workflow.nodes)) {
      logger.info(`ðŸ” Processing ${workflow.nodes.length} workflow nodes`);
      logger.info(`ðŸ” Full workflow structure:`, JSON.stringify(workflow, null, 2));
      
      for (const node of workflow.nodes) {
        logger.info(`ðŸ” Processing node: ${node.type} (${node.id})`);
        logger.info(`ðŸ” Node data:`, JSON.stringify(node.data, null, 2));
        await processItem(
          node,
          node.id,
          node.type,
          workflow.config?.voiceId
        );
      }
    } else {
      logger.warn(`âš ï¸ No nodes found. Available keys:`, Object.keys(workflow));
      if (workflow.nodes && Array.isArray(workflow.nodes)) {
        logger.info(`ðŸ” Fallback: Processing ${workflow.nodes.length} direct nodes`);
        for (const node of workflow.nodes) {
          logger.info(`ðŸ” Processing node: ${node.type} (${node.id})`);
          await processItem(
            node,
            node.id,
            node.type,
            workflow.config?.voiceId || workflow.settings?.voice
          );
        }
      }
    }

    
    // Save the updated workflow with generated audio URLs
    try {
      // Check if any nodes failed audio generation
      const failedNodes = [];
      if (workflow.nodes) {
        workflow.nodes.forEach(node => {
          if (node.audioStatus === 'failed') {
            failedNodes.push({ id: node.id, error: node.audioError });
          }
        });
      }
      
      if (failedNodes.length > 0) {
        logger.error(`âŒ Workflow save blocked due to ${failedNodes.length} failed audio generations:`, failedNodes);
        const error = new Error(`Audio generation failed for nodes: ${failedNodes.map(n => n.id).join(', ')}`);
        error.code = 'AUDIO_GENERATION_FAILED';
        error.failedNodes = failedNodes;
        throw error;
      }
      
      await workflow.save();
      logger.info(`ðŸ’¾ Saved workflow with updated audio URLs`);
    } catch (error) {
      logger.error(`âŒ Failed to save workflow:`, {
        message: error.message,
        code: error.code,
        failedNodes: error.failedNodes
      });
      throw error; // Re-throw to prevent silent failure
    }

    return workflow;
  }

  getSupportedLanguages() {
    return Object.keys(this.languageMappings).map(code => ({
      code,
      voice: this.languageMappings[code].voice
    }));
  }
}

// âœ… SINGLETON
const pythonTTSService = new PythonTTSService();
export default pythonTTSService;


