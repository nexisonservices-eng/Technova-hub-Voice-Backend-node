import crypto from 'crypto';
import axios from 'axios';
import cloudinary from "../utils/cloudinaryUtils.js";

import Broadcast from '../models/Broadcast.js';
import BroadcastCall from '../models/BroadcastCall.js';
import ttsBatchService from "../services/ttsBatchService.js";
import broadcastQueueService from './broadcastQueueService.js';
import logger from '../utils/logger.js';
import { emitStatsUpdate, emitBroadcastListUpdate, emitCallsCreated } from '../sockets/unifiedSocket.js';

class BroadcastService {
  /**
   * Create and initialize broadcast campaign
   */
  async createBroadcast(data, userId) {
    try {
      const broadcast = await Broadcast.create({
        name: data.name,
        messageTemplate: data.messageTemplate,
        voice: {
          provider: data.voice?.provider || 'edge',
          voiceId: data.voice?.voiceId || 'en-IN-NeerjaNeural',
          language: data.voice?.language || 'en-IN'
        },
        contacts: data.contacts,
        config: {
          maxConcurrent: data.maxConcurrent || 50,
          maxRetries: data.maxRetries || 2,
          retryDelay: data.retryDelay || 30000,
          compliance: data.compliance || {}
        },
        stats: {
          total: data.contacts.length
        },
        createdBy: userId
      });

      logger.info(
        `Broadcast created: ${broadcast._id} with ${data.contacts.length} contacts`
      );

      return broadcast;
    } catch (error) {
      logger.error('Failed to create broadcast:', error);
      throw error;
    }
  }

  /**
   * Start broadcast - prepare audio assets and queue calls
   */
  async startBroadcast(broadcastId) {
    try {
      const broadcast = await Broadcast.findById(broadcastId);

      if (!broadcast) {
        throw new Error('Broadcast not found');
      }

      if (broadcast.status !== 'draft') {
        throw new Error(`Broadcast already ${broadcast.status}`);
      }

      logger.info(`Starting broadcast: ${broadcastId}`);

      // PHASE 1: Pre-generate ALL audio
      logger.info('Step 1: Generating TTS for all messages...');
      const { audioAssets, personalizedMessages } = await this.generateAllAudio(broadcast);

      broadcast.audioAssets = audioAssets;
      await broadcast.save();

      // PHASE 2: Create call documents with audio URLs
      logger.info('Step 2: Creating call documents...');
      await this._createBroadcastCalls(broadcast, audioAssets, personalizedMessages);

      // PHASE 3: Start queue processor
      logger.info('Step 3: Starting call queue...');
      broadcastQueueService.startBroadcast(broadcastId);

      logger.info(`Broadcast ${broadcastId} started successfully`);
      await this._broadcastStatsUpdate();
      emitBroadcastListUpdate();

      return broadcast;
    } catch (error) {
      logger.error(`Failed to start broadcast ${broadcastId}:`, error);
      throw error;
    }
  }

  async generateAllAudio(broadcast) {
    const { messageTemplate, contacts, voice } = broadcast;

    // Create single audio message for all contacts
    const singleMessage = {
      text: messageTemplate,
      uniqueKey: crypto.createHash('md5').update(messageTemplate).digest('hex')
    };

    logger.info(`Generating TTS for single message to ${contacts.length} contacts`);

    // Generate single TTS audio
    const audioAssets = await this.generateSingleAudio(singleMessage, voice);

    return {
      audioAssets: [audioAssets],
      personalizedMessages: contacts.map(contact => ({
        text: messageTemplate,
        uniqueKey: singleMessage.uniqueKey,
        contact: contact
      }))
    };
  }

  async generateSingleAudio(message, voice) {
    try {
      // Call Python TTS service
      const ttsResponse = await axios.post(
        'https://technova-hub-voice-backend-python.onrender.com/tts/broadcast',
        {
          text: message.text,
          voice: voice.voiceId,
          provider: voice.provider
        },
        {
          responseType: 'arraybuffer',
          timeout: 30000
        }
      );

      // Upload to Cloudinary
      const audioBuffer = Buffer.from(ttsResponse.data);
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'video',
            folder: process.env.CLOUDINARY_BROADCAST_AUDIO_FOLDER || 'broadcast-audio',
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
        duration: Math.ceil(message.text.split(' ').length / 2.5) // Estimate
      };
    } catch (error) {
      logger.error(
        `Failed to generate audio for message: ${message.text}`,
        error
      );
      throw error;
    }
  }

  /**
   * Create individual call documents
   */
  async _createBroadcastCalls(broadcast, audioAssets, personalizedMessages) {
    const callDocs = personalizedMessages.map(msg => {
      // All contacts use the same single audio asset
      const audioAsset = audioAssets[0];

      return {
        broadcast: broadcast._id,
        contact: {
          phone: msg.contact.phone?.trim(),
          name: msg.contact.name?.trim() || 'Customer',
          customFields: msg.contact.customFields || {}
        },
        personalizedMessage: {
          text: msg.text?.trim() || '',
          audioUrl: audioAsset?.audioUrl,
          audioAssetId: audioAsset?._id || null
        },
        status: 'queued',
        attempts: 0
      };
    });

    await BroadcastCall.insertMany(callDocs);

    logger.info(
      `Created ${callDocs.length} call documents for broadcast ${broadcast._id}`
    );

    // 🔥 Notify frontend that calls are ready (Fixes empty list race condition)
    emitCallsCreated(broadcast._id);
  }

  /**
   * Get broadcast status with real-time stats
   */
  async getBroadcastStatus(broadcastId) {
    const broadcast = await Broadcast.findById(broadcastId)
      .populate('createdBy', 'name email');

    if (!broadcast) {
      throw new Error('Broadcast not found');
    }

    const stats = await BroadcastCall.aggregate([
      { $match: { broadcast: broadcast._id } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const statMap = {};
    stats.forEach(s => {
      statMap[s._id] = s.count;
    });

    broadcast.stats = {
      total: broadcast.stats.total,
      queued: statMap.queued || 0,
      calling: statMap.calling || 0,
      answered: statMap.answered || 0,
      completed: statMap.completed || 0,
      failed: statMap.failed || 0,
      opted_out: statMap.opted_out || 0
    };

    await broadcast.save();

    return broadcast;
  }

  /**
   * Cancel ongoing broadcast
   */
  async cancelBroadcast(broadcastId) {
    const broadcast = await Broadcast.findById(broadcastId);

    if (!broadcast) {
      throw new Error('Broadcast not found');
    }

    broadcastQueueService.stopBroadcast(broadcastId);

    await BroadcastCall.updateMany(
      { broadcast: broadcastId, status: 'queued' },
      { status: 'cancelled' }
    );

    await broadcast.updateStatus('cancelled');

    logger.info(`Broadcast ${broadcastId} cancelled`);

    await this._broadcastStatsUpdate();
    emitBroadcastListUpdate();

    return broadcast;
  }

  /**
   * Delete broadcast and associated calls
   */
  async deleteBroadcast(broadcastId) {
    const broadcast = await Broadcast.findById(broadcastId);

    if (!broadcast) {
      throw new Error('Broadcast not found');
    }

    // Stop if running
    if (broadcast.status === 'in_progress') {
      broadcastQueueService.stopBroadcast(broadcastId);
    }

    // Delete all associated calls
    await BroadcastCall.deleteMany({ broadcast: broadcastId });

    // Delete broadcast
    await Broadcast.findByIdAndDelete(broadcastId);

    logger.info(`Broadcast ${broadcastId} deleted`);

    await this._broadcastStatsUpdate();
    emitBroadcastListUpdate();

    return { success: true };
  }

  /**
   * Hash message for deduplication
   */
  _hashMessage(text) {
    return crypto.createHash('md5').update(text).digest('hex');
  }

  /**
   * Calculate and emit dashboard stats
   */
  async _broadcastStatsUpdate() {
    try {
      const total = await Broadcast.countDocuments();
      const active = await Broadcast.countDocuments({ status: 'in_progress' });

      emitStatsUpdate({
        totalCampaigns: total,
        activeCampaigns: active
      });

      emitBroadcastListUpdate();
    } catch (error) {
      logger.error('Failed to update stats:', error);
    }
  }
}

export default new BroadcastService();
