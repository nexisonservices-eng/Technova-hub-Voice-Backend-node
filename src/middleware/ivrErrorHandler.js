import logger from '../utils/logger.js';
import twilio from 'twilio';

class IVRErrorHandler {
  constructor() {
    this.errorTypes = {
      TTS_GENERATION_FAILED: 'TTS_GENERATION_FAILED',
      CLOUDINARY_UPLOAD_FAILED: 'CLOUDINARY_UPLOAD_FAILED',
      AUDIO_NOT_FOUND: 'AUDIO_NOT_FOUND',
      INVALID_LANGUAGE: 'INVALID_LANGUAGE',
      DATABASE_ERROR: 'DATABASE_ERROR',
      TWILIO_WEBHOOK_ERROR: 'TWILIO_WEBHOOK_ERROR',
      SESSION_EXPIRED: 'SESSION_EXPIRED',
      RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED'
    };
  }

  /**
   * Handle TTS generation errors with fallback strategies
   */
  handleTTSError(error, language, text) {
    logger.error(`TTS Error for language ${language}:`, error);
    
    const errorResponse = {
      type: this.errorTypes.TTS_GENERATION_FAILED,
      language,
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString(),
      fallbackOptions: []
    };

    // Fallback strategy 1: Try alternative voice for same language
    if (language === 'en-US') {
      errorResponse.fallbackOptions.push({
        strategy: 'alternative_voice',
        voice: 'en-US-Standard-C',
        description: 'Using standard voice instead of neural voice'
      });
    }

    // Fallback strategy 2: Try English as fallback language
    if (language !== 'en-US') {
      errorResponse.fallbackOptions.push({
        strategy: 'language_fallback',
        fallbackLanguage: 'en-US',
        description: 'Falling back to English'
      });
    }

    // Fallback strategy 3: Use Twilio TTS
    errorResponse.fallbackOptions.push({
      strategy: 'twilio_tts',
      description: 'Using Twilio text-to-speech as final fallback'
    });

    return errorResponse;
  }

  /**
   * Handle Cloudinary upload errors
   */
  handleCloudinaryError(error, audioBuffer, promptKey, language) {
    logger.error(`Cloudinary upload error for ${promptKey}-${language}:`, error);
    
    return {
      type: this.errorTypes.CLOUDINARY_UPLOAD_FAILED,
      promptKey,
      language,
      timestamp: new Date().toISOString(),
      fallbackOptions: [
        {
          strategy: 'local_storage',
          description: 'Storing audio locally temporarily'
        },
        {
          strategy: 'retry_upload',
          description: 'Retrying upload with exponential backoff'
        },
        {
          strategy: 'alternative_provider',
          description: 'Using alternative cloud storage provider'
        }
      ]
    };
  }

  /**
   * Handle missing audio files with intelligent fallbacks
   */
  handleMissingAudio(promptKey, language, availableLanguages) {
    logger.warn(`Missing audio for ${promptKey} in ${language}`);
    
    const fallbackOptions = [];
    
    // Try to find similar language
    const similarLanguages = this.findSimilarLanguages(language, availableLanguages);
    if (similarLanguages.length > 0) {
      fallbackOptions.push({
        strategy: 'similar_language',
        suggestedLanguages: similarLanguages,
        description: `Using similar language: ${similarLanguages.join(', ')}`
      });
    }

    // Always include English as universal fallback
    if (!availableLanguages.includes('en-US')) {
      fallbackOptions.push({
        strategy: 'universal_fallback',
        fallbackLanguage: 'en-US',
        description: 'Using English as universal fallback'
      });
    }

    // Generate audio on-demand as last resort
    fallbackOptions.push({
      strategy: 'on_demand_generation',
      description: 'Generating audio on-demand (may cause delay)'
    });

    return {
      type: this.errorTypes.AUDIO_NOT_FOUND,
      promptKey,
      language,
      availableLanguages,
      timestamp: new Date().toISOString(),
      fallbackOptions
    };
  }

  /**
   * Find linguistically similar languages
   */
  findSimilarLanguages(targetLanguage, availableLanguages) {
    const similarityMap = {
      'ta-IN': ['hi-IN'], // Tamil and Hindi are both Indian languages
      'hi-IN': ['ta-IN'], // Hindi and Tamil are both Indian languages
      'en-US': [] // English is usually the fallback, not the target
    };

    return similarityMap[targetLanguage]?.filter(lang => availableLanguages.includes(lang)) || [];
  }

  /**
   * Handle Twilio webhook errors gracefully
   */
  handleTwilioError(error, callSid, endpoint) {
    logger.error(`Twilio webhook error for call ${callSid} at ${endpoint}:`, error);
    
    return {
      type: this.errorTypes.TWILIO_WEBHOOK_ERROR,
      callSid,
      endpoint,
      timestamp: new Date().toISOString(),
      fallbackResponse: this.generateFallbackTwiml(error)
    };
  }

  /**
   * Generate fallback TwiML response
   */
  generateFallbackTwiml(error) {
    const { twiml } = twilio;
    const response = new twiml.VoiceResponse();
    
    // Basic error message in English
    response.say({ 
      language: 'en-US',
      rate: 'slow' 
    }, 'We are experiencing technical difficulties. Please try again later.');
    
    // Add retry option
    const gather = response.gather({
      numDigits: 1,
      timeout: 5,
      action: '/ivr/welcome',
      method: 'POST'
    });
    
    gather.say({ 
      language: 'en-US',
      rate: 'slow' 
    }, 'Press 1 to try again, or hang up to disconnect.');
    
    // If no input, hang up after timeout
    response.hangup();
    
    return response.toString();
  }

  /**
   * Handle rate limiting
   */
  handleRateLimit(requestId, limit, windowMs) {
    logger.warn(`Rate limit exceeded for request ${requestId}`);
    
    return {
      type: this.errorTypes.RATE_LIMIT_EXCEEDED,
      requestId,
      limit,
      windowMs,
      timestamp: new Date().toISOString(),
      retryAfter: Math.ceil(windowMs / 1000),
      fallbackOptions: [
        {
          strategy: 'queue_request',
          description: 'Request has been queued and will be processed shortly'
        },
        {
          strategy: 'cached_response',
          description: 'Returning cached response if available'
        }
      ]
    };
  }

  /**
   * Handle database connection errors
   */
  handleDatabaseError(error, operation) {
    logger.error(`Database error during ${operation}:`, error);
    
    return {
      type: this.errorTypes.DATABASE_ERROR,
      operation,
      timestamp: new Date().toISOString(),
      fallbackOptions: [
        {
          strategy: 'cache_fallback',
          description: 'Using cached data if available'
        },
        {
          strategy: 'read_replica',
          description: 'Attempting to read from replica database'
        },
        {
          strategy: 'graceful_degradation',
          description: 'Operating with limited functionality'
        }
      ]
    };
  }

  /**
   * Create standardized error response
   */
  createErrorResponse(errorType, details, statusCode = 500) {
    const error = {
      success: false,
      error: {
        type: errorType,
        timestamp: new Date().toISOString(),
        ...details
      }
    };

    // Log error for monitoring
    logger.error(`IVR Error [${errorType}]:`, details);

    return {
      statusCode,
      body: error
    };
  }

  /**
   * Recovery strategies for different error types
   */
  async executeRecoveryStrategy(strategy, context) {
    logger.info(`Executing recovery strategy: ${strategy.strategy}`);
    
    switch (strategy.strategy) {
      case 'language_fallback':
        return await this.executeLanguageFallback(strategy.fallbackLanguage, context);
      
      case 'twilio_tts':
        return await this.executeTwilioTTSFallback(context);
      
      case 'on_demand_generation':
        return await this.executeOnDemandGeneration(context);
      
      case 'retry_upload':
        return await this.executeRetryUpload(context);
      
      case 'cache_fallback':
        return await this.executeCacheFallback(context);
      
      default:
        throw new Error(`Unknown recovery strategy: ${strategy.strategy}`);
    }
  }

  /**
   * Execute language fallback strategy
   */
  async executeLanguageFallback(fallbackLanguage, context) {
    // This would integrate with the TTS service
    logger.info(`Falling back to ${fallbackLanguage} for ${context.promptKey}`);
    // Implementation would call the TTS service with fallback language
    return { success: true, fallbackLanguage };
  }

  /**
   * Execute Twilio TTS fallback
   */
  async executeTwilioTTSFallback(context) {
    // This would generate TwiML with Say verb instead of Play
    logger.info(`Using Twilio TTS fallback for ${context.promptKey}`);
    return { success: true, usingTwilioTTS: true };
  }

  /**
   * Execute on-demand generation
   */
  async executeOnDemandGeneration(context) {
    // This would trigger immediate audio generation
    logger.info(`Generating audio on-demand for ${context.promptKey}`);
    return { success: true, onDemandGeneration: true };
  }

  /**
   * Execute retry upload with exponential backoff
   */
  async executeRetryUpload(context) {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        logger.info(`Retry attempt ${attempt}/${maxRetries} for ${context.promptKey}`);
        // Implementation would retry the upload
        return { success: true, retryAttempt: attempt };
      } catch (error) {
        if (attempt === maxRetries) {
          throw error;
        }
      }
    }
  }

  /**
   * Execute cache fallback
   */
  async executeCacheFallback(context) {
    // This would retrieve cached data
    logger.info(`Retrieving cached data for ${context.operation}`);
    return { success: true, fromCache: true };
  }
}

// Create singleton instance
const ivrErrorHandler = new IVRErrorHandler();

export default ivrErrorHandler;
