import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import logger from '../utils/logger.js';
import Workflow from '../models/Workflow.js';
import cloudinary from 'cloudinary';


class TTSJobQueue {
  constructor() {
    this.jobs = new Map(); // Simple in-memory queue for now
    this.processing = new Set();
    this.io = null; // Will be set by server.js
    
    // Production settings
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY_MS = 2000;
    this.JOB_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
    this.MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
    
    // Start cleanup interval
    setInterval(() => this._cleanupOldJobs(), this.JOB_CLEANUP_INTERVAL);
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
      errors: [],
      retries: 0,
      startTime: null,
      endTime: null
    };

    this.jobs.set(jobId, job);

    // Start processing asynchronously (fire-and-forget)
    this.processJob(jobId).catch(error => {
      logger.error(`❌ Unhandled error in TTS job ${jobId}:`, error);
    });

    logger.info(`📋 TTS job ${jobId} queued for workflow ${workflowId} with ${nodes.length} nodes`);
    return jobId;
  }


  async processJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || this.processing.has(jobId)) return;

    this.processing.add(jobId);
    job.status = 'processing';
    job.startTime = new Date();

    logger.info(`🔄 Processing TTS job ${jobId} for workflow ${job.workflowId}`);

    try {
      const workflow = await Workflow.findById(job.workflowId);
      if (!workflow) {
        throw new Error(`Workflow ${job.workflowId} not found`);
      }

      // Update status to processing (Safe update)
      await Workflow.findByIdAndUpdate(job.workflowId, { ttsStatus: 'processing' });

      // Process each node with retry logic
      const processedNodes = [];
      const failedNodes = [];

      for (let i = 0; i < job.nodes.length; i++) {
        const node = job.nodes[i];
        let nodeSuccess = false;
        let nodeRetries = 0;
        let lastError = null;

        // Retry loop for each node
        while (!nodeSuccess && nodeRetries < this.MAX_RETRIES) {
          try {
            // Generate audio for this node
            const audioResult = await this.generateNodeAudio(workflow, node, job.forceRegenerate);
            
            processedNodes.push({
              nodeId: node.id,
              audioUrl: audioResult.audioUrl,
              audioAssetId: audioResult.publicId
            });
            
            nodeSuccess = true;
            job.processedNodes++;

            logger.info(`✅ Generated audio for node ${node.id} (${job.processedNodes}/${job.totalNodes})`);

          } catch (nodeError) {
            nodeRetries++;
            lastError = nodeError;
            
            logger.warn(`⚠️ Node ${node.id} attempt ${nodeRetries}/${this.MAX_RETRIES} failed:`, nodeError.message);
            
            if (nodeRetries < this.MAX_RETRIES) {
              // Wait before retry
              await this._delay(this.RETRY_DELAY_MS * nodeRetries);
            }
          }
        }

        if (!nodeSuccess) {
          failedNodes.push({
            nodeId: node.id,
            error: lastError?.message || 'Unknown error'
          });
          job.errors.push({
            nodeId: node.id,
            error: lastError?.message || 'Unknown error',
            retries: nodeRetries
          });
        }

        // Emit progress update after each node
        this._emitProgress(job, node.id);
      }

      // Execute all successful node updates atomically
      if (processedNodes.length > 0) {
        await this._updateWorkflowNodes(job.workflowId, processedNodes);
      }

      // Determine final status
      const allSuccessful = failedNodes.length === 0;
      const partialSuccess = processedNodes.length > 0 && failedNodes.length > 0;
      
      job.status = allSuccessful ? 'completed' : (partialSuccess ? 'partial' : 'failed');
      job.endTime = new Date();

      // Update workflow status
      const finalTtsStatus = allSuccessful ? 'completed' : (partialSuccess ? 'completed' : 'failed');
      await Workflow.findByIdAndUpdate(job.workflowId, { ttsStatus: finalTtsStatus });

      // Emit completion event
      this._emitCompletion(job, processedNodes, failedNodes);

      logger.info(`🎉 TTS job ${jobId} ${job.status} for workflow ${job.workflowId} (${processedNodes.length}/${job.totalNodes} nodes)`);

    } catch (error) {
      logger.error(`❌ TTS job ${jobId} failed:`, error);
      job.status = 'failed';
      job.error = error.message;
      job.endTime = new Date();

      // Update workflow status to failed safely
      try {
        await Workflow.findByIdAndUpdate(job.workflowId, { ttsStatus: 'failed' });
      } catch (updateError) {
        logger.error(`Failed to update workflow status for job ${jobId}:`, updateError);
      }

      // Emit failure event
      this._emitFailure(job, error);
    } finally {
      this.processing.delete(jobId);
    }
  }

  /**
   * Update workflow nodes atomically
   */
  async _updateWorkflowNodes(workflowId, processedNodes) {
    logger.info(`📝 Starting update for ${processedNodes.length} nodes in workflow ${workflowId}`);
    
    try {
      // Fetch the workflow
      const workflow = await Workflow.findById(workflowId);
      if (!workflow) {
        throw new Error(`Workflow ${workflowId} not found`);
      }

      // Update nodes in memory
      let updatedCount = 0;
      for (const nodeUpdate of processedNodes) {
        const nodeIndex = workflow.nodes.findIndex(n => n.id === nodeUpdate.nodeId);
        
        if (nodeIndex === -1) {
          logger.error(`❌ Node ${nodeUpdate.nodeId} not found in workflow`);
          continue;
        }

        // Update both data object and top-level fields
        if (!workflow.nodes[nodeIndex].data) {
          workflow.nodes[nodeIndex].data = {};
        }
        
        workflow.nodes[nodeIndex].data.audioUrl = nodeUpdate.audioUrl;
        workflow.nodes[nodeIndex].data.audioAssetId = nodeUpdate.audioAssetId;
        
        // Also update top-level fields for backward compatibility
        workflow.nodes[nodeIndex].audioUrl = nodeUpdate.audioUrl;
        workflow.nodes[nodeIndex].audioAssetId = nodeUpdate.audioAssetId;
        
        // Mark as modified so Mongoose saves it
        workflow.markModified(`nodes.${nodeIndex}.data`);
        workflow.markModified(`nodes.${nodeIndex}`);
        
        updatedCount++;
        logger.info(`✅ Prepared update for node ${nodeUpdate.nodeId}: ${nodeUpdate.audioUrl}`);
      }

      // Save the entire workflow
      if (updatedCount > 0) {
        await workflow.save();
        logger.info(`💾 Saved workflow ${workflowId} with ${updatedCount} updated nodes`);
        
        // Verify the save by re-fetching the workflow
        const verifyWorkflow = await Workflow.findById(workflowId);
        const verifyNodes = verifyWorkflow.nodes.filter(n => 
          processedNodes.some(pn => pn.nodeId === n.id)
        );
        
        for (const node of verifyNodes) {
          const hasAudioUrl = !!(node.data?.audioUrl || node.audioUrl);
          logger.info(`🔍 Verification: Node ${node.id} has audioUrl: ${hasAudioUrl} (${node.data?.audioUrl || node.audioUrl || 'MISSING'})`);
        }
      }
      
      return updatedCount;

    } catch (error) {
      logger.error(`❌ Failed to update workflow ${workflowId}:`, error);
      throw error;
    }
  }



  /**
   * Emit progress update via Socket.IO
   */
  _emitProgress(job, currentNodeId) {
    if (!this.io) return;

    const progress = (job.processedNodes / job.totalNodes) * 100;
    
    this.io.emit(`workflow-${job.workflowId}-progress`, {
      jobId: job.id,
      nodeId: currentNodeId,
      progress: Math.round(progress),
      processedNodes: job.processedNodes,
      totalNodes: job.totalNodes,
      status: 'processing'
    });

    // Also emit to general workflow channel
    this.io.emit('workflow_updated', {
      workflowId: job.workflowId,
      ttsStatus: 'processing',
      ttsProgress: Math.round(progress),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Emit completion event via Socket.IO
   */
  _emitCompletion(job, processedNodes, failedNodes) {
    if (!this.io) return;

    const eventData = {
      jobId: job.id,
      workflowId: job.workflowId,
      status: job.status,
      processedNodes: job.processedNodes,
      totalNodes: job.totalNodes,
      successfulNodes: processedNodes.length,
      failedNodes: failedNodes.length,
      errors: job.errors,
      duration: job.endTime - job.startTime,
      timestamp: new Date().toISOString()
    };

    // Emit to workflow-specific channel
    this.io.emit(`workflow-${job.workflowId}-completed`, eventData);
    
    // Convert processedNodes array to object mapped by nodeId (frontend expects this format)
    const audioUrlsObject = {};
    for (const node of processedNodes) {
      audioUrlsObject[node.nodeId] = {
        audioUrl: node.audioUrl,
        audioAssetId: node.audioAssetId
      };
    }
    
    // Emit to general workflow channel
    this.io.emit('workflow_updated', {
      workflowId: job.workflowId,
      ttsStatus: job.status === 'completed' ? 'completed' : 'partial',
      audioUrls: audioUrlsObject,  // Now an object mapped by nodeId
      timestamp: new Date().toISOString()
    });

    logger.info(`ttsJobQueue: Emitted completion event for workflow ${job.workflowId} with ${processedNodes.length} audio URLs`);
  }


  /**
   * Emit failure event via Socket.IO
   */
  _emitFailure(job, error) {
    if (!this.io) return;

    const eventData = {
      jobId: job.id,
      workflowId: job.workflowId,
      error: error.message,
      status: 'failed',
      timestamp: new Date().toISOString()
    };

    this.io.emit(`workflow-${job.workflowId}-failed`, eventData);
    this.io.emit('workflow_updated', {
      workflowId: job.workflowId,
      ttsStatus: 'failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Delay helper for retries
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cleanup old completed jobs
   */
  _cleanupOldJobs() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      // Remove completed/failed jobs older than MAX_JOB_AGE_MS
      if ((job.status === 'completed' || job.status === 'failed') && 
          job.endTime && 
          (now - job.endTime.getTime()) > this.MAX_JOB_AGE_MS) {
        this.jobs.delete(jobId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`🧹 Cleaned up ${cleanedCount} old TTS jobs`);
    }
  }


  async generateNodeAudio(workflow, node, forceRegenerate = false) {
    logger.info(`🎙️ Generating audio for node ${node.id} (type: ${node.type})`);
    logger.info(`🎙️ Node data: ${JSON.stringify(node.data, null, 2)}`);
    
    // Extract text from node based on type - comprehensive text extraction
    let text = '';
    let language = node.language || node?.data?.language || 'en-GB';
    let voice = node.voice || node?.data?.voice || 'en-GB-SoniaNeural';

    // Try all possible text fields in priority order
    const data = node.data || {};
    
    // Log all available fields for debugging
    logger.info(`🔍 Available fields in node.data: ${Object.keys(data).join(', ')}`);
    logger.info(`🔍 Checking for text in fields: messageText=${data.messageText}, text=${data.text}, message=${data.message}, prompt=${data.prompt}`);
    
    switch (node.type) {
      case 'message':
        text = data.message || data.text || data.messageText || '';
        break;
      case 'menu':
        text = data.message || data.text || data.messageText || '';
        break;
      case 'prompt':
        text = data.prompt || data.message || data.text || data.messageText || '';
        break;
      case 'audio':
      case 'greeting':
        // For audio/greeting nodes, messageText is the primary field
        // Backend transforms messageText -> text, so check both
        text = data.messageText || data.text || data.message || '';
        logger.info(`🔍 Audio/Greeting node: checked messageText="${data.messageText}", text="${data.text}", message="${data.message}"`);
        break;
      case 'input':
        // Input nodes might have prompt text
        text = data.prompt || data.message || data.messageText || data.text || '';
        break;
      case 'end':
        // End nodes might have a final message
        text = data.message || data.messageText || data.text || '';
        break;
      default:
        // Fallback: try all common text fields
        text = data.messageText || data.message || data.text || data.prompt || '';
    }

    // Trim and validate
    text = text?.trim() || '';

    if (!text) {
      logger.error(`❌ No text found for node ${node.id} of type ${node.type}`);
      logger.error(`❌ Available data fields: ${Object.keys(data).join(', ')}`);
      logger.error(`❌ Node data content: ${JSON.stringify(data)}`);
      throw new Error(`No text found for node ${node.id} of type ${node.type}. Checked fields: messageText, message, text, prompt`);
    }

    logger.info(`📝 Text for node ${node.id}: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);


    // Generate audio using VoiceBroadcast pattern (direct axios call)
    const aiServiceUrl = process.env.AI_SERVICE_HTTP || process.env.PYTHON_TTS_URL || 'http://localhost:4000';
    let audioBuffer;
    let ttsSuccess = false;
    let lastError = null;
    
    // Try TTS service with retries
    const maxTtsRetries = 2;
    for (let attempt = 1; attempt <= maxTtsRetries; attempt++) {
      try {
        logger.info(`🔊 Calling TTS service (attempt ${attempt}/${maxTtsRetries}): ${aiServiceUrl}/tts/broadcast`);
        const ttsResponse = await axios.post(
          `${aiServiceUrl}/tts/broadcast`,
          {
            text: text,
            voice: voice,
            provider: 'edge',
            language: language
          },
          {
            responseType: 'arraybuffer',
            timeout: 30000
          }
        );
        
        audioBuffer = Buffer.from(ttsResponse.data);
        logger.info(`🔊 Generated audio buffer: ${audioBuffer.length} bytes`);
        ttsSuccess = true;
        break; // Success, exit retry loop
        
      } catch (ttsError) {
        lastError = ttsError;
        logger.warn(`⚠️ TTS attempt ${attempt}/${maxTtsRetries} failed for node ${node.id}:`, ttsError.message);
        
        if (attempt < maxTtsRetries) {
          // Wait before retry with exponential backoff
          const delayMs = 1000 * Math.pow(2, attempt - 1);
          logger.info(`⏳ Waiting ${delayMs}ms before retry...`);
          await this._delay(delayMs);
        }
      }
    }
    
    // If TTS service failed, create a fallback using Twilio's native TTS
    if (!ttsSuccess) {
      logger.error(`❌ TTS service failed after ${maxTtsRetries} attempts. Using Twilio native TTS fallback.`);
      
      // Create a TwiML response with Say verb as fallback
      const twilio = await import('twilio');
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      
      // Map voice to Twilio voice
      const twilioVoice = this._mapToTwilioVoice(voice);
      response.say({ voice: twilioVoice, language: language }, text);
      
      // Convert TwiML to audio-like response (we'll store the TwiML as a data URL)
      const twimlString = response.toString();
      const twimlBuffer = Buffer.from(twimlString, 'utf-8');
      
      logger.info(`🔊 Using Twilio native TTS fallback for node ${node.id}`);
      
      // Return a special marker that indicates Twilio TTS should be used
      return {
        audioUrl: `data:application/xml;base64,${twimlBuffer.toString('base64')}`,
        publicId: `twilio_tts_${node.id}_${Date.now()}`,
        duration: Math.ceil(text.split(' ').length / 2.5),
        isTwilioTTS: true,
        twiml: twimlString
      };
    }
    
    // Upload to Cloudinary using VoiceBroadcast pattern
    let uploadResult;
    try {
      const uniqueKey = `ivr_${workflow.promptKey || workflow._id}_${node.id}_${Date.now()}`;
      const folder = process.env.CLOUDINARY_IVR_AUDIO_FOLDER || 'ivr-audio';
      
      logger.info(`☁️ Uploading to Cloudinary: ${folder}/${uniqueKey}`);
      
      uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.v2.uploader.upload_stream(
          {
            resource_type: 'video',
            folder: folder,
            public_id: uniqueKey,
            format: 'mp3'
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(audioBuffer);
      });
      
      logger.info(`☁️ Uploaded to Cloudinary: ${uploadResult.secure_url}`);
    } catch (uploadError) {
      logger.error(`❌ Cloudinary upload failed for node ${node.id}:`, uploadError.message);
      throw new Error(`Cloudinary upload failed: ${uploadError.message}`);
    }

    return {
      audioUrl: uploadResult.secure_url,
      publicId: uploadResult.public_id,
      duration: Math.ceil(text.split(' ').length / 2.5), // Estimate duration
      isTwilioTTS: false
    };
  }

  /**
   * Map voice ID to Twilio voice
   */
  _mapToTwilioVoice(voice) {
    const voiceMap = {
      'en-GB-SoniaNeural': 'Polly.Amy',
      'en-GB-RyanNeural': 'Polly.Brian',
      'en-GB-LibbyNeural': 'Polly.Emma',
      'en-GB-ThomasNeural': 'Polly.Joey',
      'ta-IN-PallaviNeural': 'Polly.Aditi',
      'ta-IN-ValluvarNeural': 'Polly.Aditi',
      'hi-IN-SwaraNeural': 'Polly.Aditi',
      'hi-IN-MadhurNeural': 'Polly.Aditi'
    };
    
    return voiceMap[voice] || 'Polly.Amy';
  }





  getJobStatus(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    // Calculate additional stats
    const duration = job.endTime ? job.endTime - job.startTime : (job.startTime ? Date.now() - job.startTime : 0);
    const progress = job.totalNodes > 0 ? (job.processedNodes / job.totalNodes) * 100 : 0;

    return {
      ...job,
      duration,
      progress: Math.round(progress),
      remainingNodes: job.totalNodes - job.processedNodes
    };
  }

  getJobsForWorkflow(workflowId) {
    return Array.from(this.jobs.values())
      .filter(job => job.workflowId === workflowId)
      .map(job => this.getJobStatus(job.id));
  }

  /**
   * Get queue statistics
   */
  getQueueStats() {
    const jobs = Array.from(this.jobs.values());
    return {
      totalJobs: jobs.length,
      pending: jobs.filter(j => j.status === 'pending').length,
      processing: jobs.filter(j => j.status === 'processing').length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      activeJobs: this.processing.size
    };
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.status !== 'failed' && job.status !== 'partial') {
      throw new Error(`Cannot retry job with status: ${job.status}`);
    }

    // Reset job state
    job.status = 'pending';
    job.processedNodes = 0;
    job.errors = [];
    job.retries++;
    job.startTime = null;
    job.endTime = null;

    // Re-queue the job
    this.processJob(jobId).catch(error => {
      logger.error(`❌ Unhandled error in retry of TTS job ${jobId}:`, error);
    });

    logger.info(`🔄 Retrying TTS job ${jobId} (attempt ${job.retries})`);
    return jobId;
  }
}


export default new TTSJobQueue();
