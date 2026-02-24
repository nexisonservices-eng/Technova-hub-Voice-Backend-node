import axios from 'axios';
import { uploadToCloudinary, isCloudinaryConfigured } from "../../src/utils/cloudinaryUtils.js";
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

class TTSBatchService {
  constructor() {
    this.pythonServiceUrl =
      process.env.AI_SERVICE_HTTP ||
      process.env.PYTHON_TTS_SERVICE_URL ||
      'http://localhost:4000';
  }


  /**
   * Generate TTS audio for batch of unique messages
   */
  async generateBatch(uniqueMessages, voiceConfig) {
    try {
      logger.info(
        `Generating TTS batch: ${uniqueMessages.length} messages`
      );

      const results = await Promise.all(
        uniqueMessages.map(msg =>
          this._generateSingle(msg, voiceConfig)
        )
      );

      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

      logger.info(
        `TTS batch complete: ${successful.length} success, ${failed.length} failed`
      );

      if (failed.length > 0) {
        logger.error(
          'TTS batch failures:',
          failed.map(f => f.error)
        );
      }

      return successful.map(r => ({
        uniqueKey: r.uniqueKey,
        text: r.text,
        audioUrl: r.audioUrl,
        duration: r.duration,
        generatedAt: new Date()
      }));
    } catch (error) {
      logger.error('TTS batch generation failed:', error);
      throw error;
    }
  }

  /**
   * Generate single TTS audio
   */
  async _generateSingle(message, voiceConfig) {
    try {
      const response = await axios.post(
        `${this.pythonServiceUrl}/tts/broadcast`,
        {

          text: message.text,
          voice: voiceConfig.voiceId,
          provider: voiceConfig.provider,
          language: voiceConfig.language
        },
        {
          timeout: 30000,
          responseType: 'arraybuffer'
        }
      );

      const audioBuffer = Buffer.from(response.data);
      const fileName = `broadcast/${message.uniqueKey}.${this._getAudioFormat(
        voiceConfig.provider
      )}`;

      let uploadResult;

      // Try Cloudinary first, fallback to local storage
      if (isCloudinaryConfigured()) {
        try {
          uploadResult = await uploadToCloudinary(audioBuffer, fileName, {
            format: this._getAudioFormat(voiceConfig.provider)
          });
          logger.info(`Audio uploaded to Cloudinary: ${fileName}`);
        } catch (cloudinaryError) {
          logger.warn(`Cloudinary upload failed, using local storage: ${cloudinaryError.message}`);
          uploadResult = await this._saveLocal(audioBuffer, fileName);
        }
      } else {
        logger.info(`Cloudinary not configured, using local storage for: ${fileName}`);
        uploadResult = await this._saveLocal(audioBuffer, fileName);
      }

      return {
        success: true,
        uniqueKey: message.uniqueKey,
        text: message.text,
        audioUrl: uploadResult.url,
        duration: this._estimateDuration(message.text)
      };
    } catch (error) {
      logger.error(
        `TTS failed for message ${message.uniqueKey}:`,
        error.message
      );

      return {
        success: false,
        uniqueKey: message.uniqueKey,
        text: message.text,
        error: error.message
      };
    }
  }

  /**
   * Get audio format based on TTS provider
   */
  _getAudioFormat(provider) {
    switch (provider) {
      case 'edge':
      case 'elevenlabs':
      default:
        return 'mp3';
    }
  }

  /**
   * Get content type for upload
   */
  _getContentType(provider) {
    const format = this._getAudioFormat(provider);
    return `audio/${format}`;
  }

  /**
   * Estimate audio duration
   * ~150 WPM = 2.5 words/sec
   */
  _estimateDuration(text) {
    const wordCount = text.split(' ').length;
    return Math.ceil(wordCount / 2.5);
  }
}

export default new TTSBatchService();
