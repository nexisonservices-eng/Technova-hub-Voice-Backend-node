import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import pythonTTSService from './pythonTTSService.js';
import Workflow from '../models/Workflow.js';

class TTSJobQueue {
  constructor() {
    this.jobs = new Map(); // Simple in-memory queue for now
    this.processing = new Set();
    this.io = null; // Will be set by server.js
  }

  setSocketIO(io) {
    this.io = io;
    logger.info('🔌 ttsJobQueue: Socket.IO instance set via setSocketIO');
  }

  async addJob(workflowId, nodes, forceRegenerate = false) {
    logger.info(`ttsJobQueue: addJob called. Has IO? ${!!this.io}`);
    const jobId = uuidv4();
    const job = {
      id: jobId,
      workflowId,
      nodes,
      forceRegenerate,
      status: 'pending',
      createdAt: new Date(),
      processedNodes: 0,
      totalNodes: nodes.length,
      errors: []
    };

    this.jobs.set(jobId, job);

    // Start processing asynchronously
    this.processJob(jobId);

    logger.info(`📋 TTS job ${jobId} queued for workflow ${workflowId} with ${nodes.length} nodes`);
    return jobId;
  }

  async processJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || this.processing.has(jobId)) return;

    this.processing.add(jobId);
    job.status = 'processing';
    job.startedAt = new Date();

    logger.info(`🔄 Processing TTS job ${jobId} for workflow ${job.workflowId}`);

    try {
      const workflow = await Workflow.findById(job.workflowId);
      if (!workflow) {
        throw new Error(`Workflow ${job.workflowId} not found`);
      }

      // Update status to processing (Safe update)
      await Workflow.findByIdAndUpdate(job.workflowId, { ttsStatus: 'processing' });

      // Prepare bulk operations for atomic node updates
      const bulkOps = [];

      // Process each node
      for (let i = 0; i < job.nodes.length; i++) {
        const node = job.nodes[i];

        try {
          // Generate audio for this node
          // Note: workflow object is mainly used for config (voice/lang), so it's fine if it's stale
          const audioResult = await this.generateNodeAudio(workflow, node, job.forceRegenerate);

          // Add atomic update for this node
          bulkOps.push({
            updateOne: {
              filter: { _id: job.workflowId, "nodes.id": node.id },
              update: {
                $set: {
                  "nodes.$.data.audioUrl": audioResult.audioUrl,
                  "nodes.$.data.audioAssetId": audioResult.publicId,
                  "nodes.$.audioUrl": audioResult.audioUrl,
                  "nodes.$.audioAssetId": audioResult.publicId
                }
              }
            }
          });

          job.processedNodes++;

          // Emit progress update
          if (this.io) {
            this.io.emit(`workflow-${job.workflowId}-progress`, {
              jobId,
              nodeId: node.id,
              progress: (job.processedNodes / job.totalNodes) * 100,
              processedNodes: job.processedNodes,
              totalNodes: job.totalNodes,
              status: 'processing'
            });
          }

          logger.info(`✅ Generated audio for node ${node.id} (${job.processedNodes}/${job.totalNodes})`);

        } catch (nodeError) {
          logger.error(`❌ Failed to generate audio for node ${node.id}:`, nodeError);
          job.errors.push({
            nodeId: node.id,
            error: nodeError.message
          });
        }
      }

      // Execute all node updates atomically
      if (bulkOps.length > 0) {
        await Workflow.bulkWrite(bulkOps);
      }

      // Update status to completed (Safe update)
      await Workflow.findByIdAndUpdate(job.workflowId, { ttsStatus: 'completed' });

      job.status = 'completed';
      job.completedAt = new Date();

      // Emit completion event
      if (this.io) {
        logger.info(`ttsJobQueue: Emitting completion event: workflow-${job.workflowId}-completed`);
        this.io.emit(`workflow-${job.workflowId}-completed`, {
          jobId,
          workflowId: job.workflowId,
          processedNodes: job.processedNodes,
          totalNodes: job.totalNodes,
          errors: job.errors,
          status: 'completed'
        });
      }

      logger.info(`🎉 TTS job ${jobId} completed for workflow ${job.workflowId}`);

    } catch (error) {
      logger.error(`❌ TTS job ${jobId} failed:`, error);
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date();

      // Update workflow status to failed safely
      try {
        await Workflow.findByIdAndUpdate(job.workflowId, { ttsStatus: 'failed' });
      } catch (updateError) {
        logger.error(`Failed to update workflow status for job ${jobId}:`, updateError);
      }

      // Emit failure event
      if (this.io) {
        this.io.emit(`workflow-${job.workflowId}-failed`, {
          jobId,
          workflowId: job.workflowId,
          error: error.message,
          status: 'failed'
        });
      }
    } finally {
      this.processing.delete(jobId);
    }
  }

  async generateNodeAudio(workflow, node, forceRegenerate = false) {
    // Extract text from node based on type
    let text = '';
    let language = node.language || node?.data?.language || 'en-GB';
    let voice = node.voice || node?.data?.voice || 'en-GB-SoniaNeural';

    switch (node.type) {
      case 'message':
        text = node.data?.message || '';
        break;
      case 'menu':
        text = node.data?.message || '';
        break;
      case 'prompt':
        text = node.data?.prompt || '';
        break;
      case 'audio':
      case 'greeting':
        text = node.data?.messageText || node.data?.text || '';
        break;
      default:
        text = node.data?.text || node.data?.message || node.data?.messageText || '';
    }

    if (!text) {
      throw new Error(`No text found for node ${node.id} of type ${node.type}`);
    }

    // Generate prompt key
    const promptKey = `${node.type}_${node.id}_${Date.now()}`;

    // Generate audio using existing service
    const audioBuffer = await pythonTTSService.generateSpeech(text, language, voice);
    const publicId = `node_${node.id}_${Date.now()}`;
    const uploadResult = await pythonTTSService.uploadToCloudinary(audioBuffer, publicId, language);

    return {
      audioUrl: uploadResult.audioUrl,
      publicId: uploadResult.publicId,
      duration: uploadResult.duration
    };
  }

  getJobStatus(jobId) {
    return this.jobs.get(jobId);
  }

  getJobsForWorkflow(workflowId) {
    return Array.from(this.jobs.values()).filter(job => job.workflowId === workflowId);
  }
}

export default new TTSJobQueue();
