import crypto from 'crypto';
import axios from 'axios';
import cloudinary, { deleteFromCloudinary } from "../utils/cloudinaryUtils.js";
import logger from '../utils/logger.js';
import Broadcast from '../models/Broadcast.js';
import BroadcastCall from '../models/BroadcastCall.js';
import ttsBatchService from "./ttsBatchService.js";
import broadcastQueueService from './broadcastQueueService.js';
import aiAssistantService from './aiAssistantService.js';
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
          voiceId: data.voice?.voiceId || 'ta-IN-PallaviNeural', // Default: Tamil – Female
          language: data.voice?.language || 'ta-IN' // Default: Tamil
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

      // PHASE 1: Generate single shared audio for all contacts
      logger.info('Step 1: Generating TTS for shared message...');

      // Create single audio message for all contacts
      const singleMessage = {
        text: broadcast.messageTemplate,
        uniqueKey: crypto.createHash('md5').update(broadcast.messageTemplate).digest('hex')
      };

      logger.info(`Generating TTS for single message to ${broadcast.contacts.length} contacts`);

      // Generate single TTS audio
      const audioAssets = await this.generateSingleAudio(singleMessage, broadcast.voice);

      const audioAssetsArray = [audioAssets];
      const personalizedMessages = broadcast.contacts.map(contact => ({
        text: broadcast.messageTemplate,
        uniqueKey: singleMessage.uniqueKey,
        contact: contact
      }));

      broadcast.audioAssets = audioAssetsArray;
      // Update status to queued so queue processor picks it up correctly
      broadcast.status = 'queued';
      await broadcast.save();

      // PHASE 2: Create call documents with audio URLs
      logger.info('Step 2: Creating call documents...');
      // USE broadcast.audioAssets to get the Mongoose IDs
      await this._createBroadcastCalls(broadcast, broadcast.audioAssets, personalizedMessages);

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


  async generateSingleAudio(message, voice) {
    try {
      // Call Python TTS service
      const aiServiceUrl = process.env.AI_SERVICE_HTTP || 'http://localhost:4000';

      const ttsResponse = await axios.post(
        `${aiServiceUrl}/tts/broadcast`,
        {
          text: message.text,
          voice: voice.voiceId,
          provider: voice.provider,
          language: voice.language
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

    // 🗑️ Delete Cloudinary Assets
    if (broadcast.audioAssets && broadcast.audioAssets.length > 0) {
      logger.info(`Deleting ${broadcast.audioAssets.length} audio assets for broadcast ${broadcastId}`);

      const folder = process.env.CLOUDINARY_BROADCAST_AUDIO_FOLDER || 'broadcast-audio';

      for (const asset of broadcast.audioAssets) {
        if (asset.uniqueKey) {
          try {
            // Cloudinary requires folder/public_id to delete
            const publicId = `${folder}/${asset.uniqueKey}`;
            await deleteFromCloudinary(publicId);
            logger.info(`Deleted audio asset: ${publicId}`);
          } catch (err) {
            logger.warn(`Failed to delete Cloudinary asset ${asset.uniqueKey}:`, err.message);
          }
        }
      }
    }

    // Delete all associated calls
    await BroadcastCall.deleteMany({ broadcast: broadcastId });

    // Delete broadcast
    await Broadcast.findByIdAndDelete(broadcastId);

    logger.info(`Broadcast ${broadcastId} fully deleted (DB + Cloudinary)`);

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
