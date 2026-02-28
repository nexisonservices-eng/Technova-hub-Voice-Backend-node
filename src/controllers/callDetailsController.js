import Call from '../models/call.js';
import BroadcastCall from '../models/BroadcastCall.js';
import Workflow from '../models/Workflow.js';
import ExecutionLog from '../models/ExecutionLog.js';
import logger from '../utils/logger.js';
import inboundCallService from '../services/inboundCallService.js';
import broadcastService from '../services/broadcastService.js';
import analyticsController from './analyticsController.js';
import {
  emitCallDetailsUpdate, 
  emitInboundCallDetailsUpdate,
  emitIVRCallDetailsUpdate,
  emitOutboundCallDetailsUpdate,
  emitCallListUpdate
} from '../sockets/unifiedSocket.js';
import { getUserObjectId } from '../utils/authContext.js';


/**
 * Call Details Controller - Provides comprehensive details for inbound, IVR, and outbound calls
 */
class CallDetailsController {
  
  /**
   * Get detailed information for a specific call by ID
   */
  async getCallDetails(req, res) {
    try {
      const { callId } = req.params;
      const { type } = req.query; // 'inbound', 'ivr', 'outbound'
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      if (!callId) {
        return res.status(400).json({
          success: false,
          error: 'Call ID is required' 
        });
      }

      let callDetails = null;

      // Try to find call in different collections based on type or search all
      if (!type || type === 'inbound' || type === 'ivr') {
        callDetails = await Call.findOne({ callSid: callId, user: userId }).lean();
      }

      if (!callDetails && (!type || type === 'outbound')) {
        callDetails = await BroadcastCall.findOne({ callSid: callId, userId })
          .populate('broadcast', 'name campaignType status')
          .lean();
      }


      if (!callDetails) {
        return res.status(404).json({
          success: false,
          error: 'Call not found'
        });
      }

      // Enrich call data with additional details
      const enrichedDetails = await this.enrichCallData(callDetails);

      res.json({
        success: true,
        data: enrichedDetails
      });

    } catch (error) {
      logger.error('Get call details error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get all calls with filtering and pagination
   */
  async getAllCalls(req, res) {
    try {
      const {
        type, // 'inbound', 'ivr', 'outbound', 'all'
        status,
        startDate,
        endDate,
        phoneNumber,
        page = 1,
        limit = 50,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const query = {};

      // Build query filters
      if (status) query.status = status;
      if (phoneNumber) {
        query.$or = [
          { phoneNumber: { $regex: phoneNumber, $options: 'i' } },
          { from: { $regex: phoneNumber, $options: 'i' } },
          { to: { $regex: phoneNumber, $options: 'i' } }
        ];
      }
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
      }

      let calls = [];
      let total = 0;

      // Fetch based on type
      if (!type || type === 'all') {
        // Get all call types
        const [inboundCalls, outboundCalls] = await Promise.all([
          Call.find({ ...query, user: userId }).sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 }).skip(skip).limit(parseInt(limit)).lean(),
          BroadcastCall.find({ ...query, userId }).populate('broadcast', 'name campaignType').sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 }).skip(skip).limit(parseInt(limit)).lean()
        ]);


        // Mark call types
        inboundCalls.forEach(c => c.callType = c.routing && c.routing !== 'default' ? 'ivr' : 'inbound');
        outboundCalls.forEach(c => c.callType = 'outbound');

        calls = [...inboundCalls, ...outboundCalls];
        total = await Call.countDocuments({ ...query, user: userId }) + await BroadcastCall.countDocuments({ ...query, userId });
      } else if (type === 'inbound') {
        query.direction = 'inbound';
        query.$or = [{ routing: 'default' }, { routing: { $exists: false } }];
        calls = await Call.find({ ...query, user: userId }).sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 }).skip(skip).limit(parseInt(limit)).lean();
        calls.forEach(c => c.callType = 'inbound');
        total = await Call.countDocuments({ ...query, user: userId });
      } else if (type === 'ivr') {
        query.direction = 'inbound';
        query.routing = { $exists: true, $ne: 'default' };
        calls = await Call.find({ ...query, user: userId }).sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 }).skip(skip).limit(parseInt(limit)).lean();
        calls.forEach(c => c.callType = 'ivr');
        total = await Call.countDocuments({ ...query, user: userId });
      } else if (type === 'outbound') {
        calls = await BroadcastCall.find({ ...query, userId }).populate('broadcast', 'name campaignType').sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 }).skip(skip).limit(parseInt(limit)).lean();
        calls.forEach(c => c.callType = 'outbound');
        total = await BroadcastCall.countDocuments({ ...query, userId });
      }


      // Enrich all calls
      const enrichedCalls = await Promise.all(calls.map(async (call) => {
        return await this.enrichCallData(call);
      }));



      res.json({
        success: true,
        data: {
          calls: enrichedCalls,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / parseInt(limit))
          }
        }
      });

    } catch (error) {
      logger.error('Get all calls error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get IVR workflow execution details
   */
  async getIVRDetails(req, res) {
    try {
      const { callId } = req.params;
      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const call = await Call.findOne({ callSid: callId, user: userId }).lean();
      
      if (!call) {
        return res.status(404).json({
          success: false,
          error: 'Call not found'
        });
      }

      // Get execution logs if available
      const executionLog = await ExecutionLog.findOne({ callSid: callId, userId }).lean();

      // Get workflow details
      let workflowDetails = null;
      if (call.routing && call.routing !== 'default') {
        workflowDetails = await Workflow.findOne({ promptKey: call.routing, createdBy: userId }).lean();
      }

      // Get IVR metrics
      const ivrMetrics = {
        menuTime: call.ivrMetrics?.menuTime || 0,
        nodePath: call.ivrMetrics?.nodePath || [],
        selections: call.ivrMetrics?.selections || [],
        completionStatus: call.ivrMetrics?.completionStatus || 'unknown',
        transferPoint: call.ivrMetrics?.transferPoint || null,
        abandonPoint: call.ivrMetrics?.abandonPoint || null
      };

      // Get conversation flow
      const conversationFlow = call.conversation?.map((msg, idx) => ({
        step: idx + 1,
        type: msg.type, // 'user' or 'ai'
        content: msg.content || msg.text,
        timestamp: msg.timestamp,
        intent: msg.intent || null,
        confidence: msg.confidence || null
      })) || [];

      res.json({
        success: true,
        data: {
          callSid: call.callSid,
          phoneNumber: call.phoneNumber || call.from,
          status: call.status,
          duration: call.duration,
          routing: call.routing,
          workflow: workflowDetails ? {
            id: workflowDetails._id,
            name: workflowDetails.displayName || workflowDetails.promptKey,
            promptKey: workflowDetails.promptKey,
            nodes: workflowDetails.nodes?.length || 0,
            edges: workflowDetails.edges?.length || 0
          } : null,
          ivrMetrics,
          executionLog: executionLog ? {
            executionId: executionLog._id,
            startTime: executionLog.startTime,
            endTime: executionLog.endTime,
            status: executionLog.status,
            nodesExecuted: executionLog.nodesExecuted || [],
            variables: executionLog.variables || {},
            errors: executionLog.errors || []
          } : null,
          conversationFlow,
          createdAt: call.createdAt,
          updatedAt: call.updatedAt
        }
      });

    } catch (error) {
      logger.error('Get IVR details error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get outbound call details with broadcast information
   */
  async getOutboundDetails(req, res) {
    try {
      const { callId } = req.params;
      const userId = getUserObjectId(req);

      const call = await BroadcastCall.findOne({ callSid: callId, userId })
        .populate('broadcastId')
        .lean();

      if (!call) {
        return res.status(404).json({
          success: false,
          error: 'Outbound call not found'
        });
      }

      // Get broadcast details
      const broadcast = call.broadcastId;

      res.json({
        success: true,
        data: {
          callSid: call.callSid,
          phoneNumber: call.phoneNumber,
          status: call.status,
          duration: call.duration,
          broadcast: broadcast ? {
            id: broadcast._id,
            name: broadcast.name,
            campaignType: broadcast.campaignType,
            status: broadcast.status,
            totalRecipients: broadcast.totalRecipients,
            completedCalls: broadcast.completedCalls,
            failedCalls: broadcast.failedCalls
          } : null,
          callAttempts: call.attempts || 1,
          lastAttemptAt: call.lastAttemptAt,
          recordingUrl: call.recordingUrl,
          transcription: call.transcription,
          cost: call.cost,
          createdAt: call.createdAt,
          updatedAt: call.updatedAt
        }
      });

    } catch (error) {
      logger.error('Get outbound details error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get inbound call details with routing information
   */
  async getInboundDetails(req, res) {
    try {
      const { callId } = req.params;
      const userId = getUserObjectId(req);

      const call = await Call.findOne({ 
        callSid: callId,
        user: userId,
        direction: 'inbound'
      }).lean();

      if (!call) {
        return res.status(404).json({
          success: false,
          error: 'Inbound call not found'
        });
      }

      // Get queue information if applicable
      const queueInfo = call.queueName ? {
        name: call.queueName,
        position: call.queuePosition,
        waitTime: call.queueWaitTime,
        agentAssigned: call.agentAssigned
      } : null;

      // Get callback information
      const callbackInfo = call.callback ? {
        requested: call.callback.requested,
        phoneNumber: call.callback.phoneNumber,
        scheduledAt: call.callback.scheduledAt,
        status: call.callback.status
      } : null;

      // Get voicemail information
      const voicemailInfo = call.voicemail ? {
        url: call.voicemail.url,
        duration: call.voicemail.duration,
        receivedAt: call.voicemail.receivedAt,
        transcribed: call.voicemail.transcribed || false,
        transcription: call.voicemail.transcription
      } : null;

      res.json({
        success: true,
        data: {
          callSid: call.callSid,
          phoneNumber: call.from,
          calledNumber: call.to,
          status: call.status,
          duration: call.duration,
          direction: call.direction,
          routing: call.routing || 'default',
          queue: queueInfo,
          callback: callbackInfo,
          voicemail: voicemailInfo,
          aiMetrics: call.aiMetrics || null,
          conversation: call.conversation || [],
          createdAt: call.createdAt,
          updatedAt: call.updatedAt
        }
      });

    } catch (error) {
      logger.error('Get inbound details error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // Helper methods


  /**
   * Enrich call data with additional details
   */
  async enrichCallData(call) {
    const enriched = { ...call };

      // Determine call type
      if (call.callType) {
        enriched.type = call.callType;
      } else if (call.broadcast) {
        enriched.type = 'outbound';
      } else if (call.routing && call.routing !== 'default') {

      enriched.type = 'ivr';
    } else {
      enriched.type = 'inbound';
    }

    // Add formatted duration
    enriched.formattedDuration = this.formatDuration(call.duration || 0);

    // Add status badge
    enriched.statusBadge = this.getStatusBadge(call.status);

    // Add call outcome
    enriched.outcome = this.determineOutcome(call);

    return enriched;
  }

  /**
   * Format duration in human readable format
   */
  formatDuration(seconds) {
    if (!seconds || seconds === 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  /**
   * Get status badge configuration
   */
  getStatusBadge(status) {
    const badges = {
      'completed': { color: 'green', label: 'Completed' },
      'failed': { color: 'red', label: 'Failed' },
      'busy': { color: 'orange', label: 'Busy' },
      'no-answer': { color: 'gray', label: 'No Answer' },
      'in-progress': { color: 'blue', label: 'In Progress' },
      'ringing': { color: 'yellow', label: 'Ringing' },
      'initiated': { color: 'purple', label: 'Initiated' }
    };
    return badges[status] || { color: 'gray', label: status };
  }

  /**
   * Determine call outcome
   */
  determineOutcome(call) {
    if (call.status === 'completed') {
      if (call.voicemail) return 'Voicemail';
      if (call.callback?.requested) return 'Callback Requested';
      if (call.aiMetrics?.totalExchanges > 0) return 'AI Handled';
      return 'Connected';
    }
    if (call.status === 'failed') return 'Failed';
    if (call.status === 'busy') return 'Busy';
    if (call.status === 'no-answer') return 'No Answer';
    return 'Unknown';
  }

  // ==================== SOCKET.IO NOTIFICATION METHODS ====================
  // These methods emit real-time updates when calls change

  /**
   * Notify all clients that a new call was created
   * Called from inbound, outbound, and IVR services when calls start
   */
  async notifyCallCreated(callData, callType) {
    try {
      const enriched = await this.enrichCallData(callData);
      
      // Emit generic call update
      emitCallDetailsUpdate(callData.callSid, {
        type: 'created',
        callType,
        data: enriched
      });

      // Emit type-specific update
      switch (callType) {
        case 'inbound':
          emitInboundCallDetailsUpdate(callData.callSid, {
            type: 'created',
            data: enriched
          });
          break;
        case 'ivr':
          emitIVRCallDetailsUpdate(callData.callSid, {
            type: 'created',
            data: enriched
          });
          break;
        case 'outbound':
          emitOutboundCallDetailsUpdate(callData.callSid, {
            type: 'created',
            data: enriched
          });
          break;
      }

      // Also update the call list
      emitCallListUpdate(callType, {
        action: 'add',
        call: enriched
      });
      await analyticsController.handleCallEvent({
        event: 'call_started',
        callSid: callData.callSid,
        callType,
        userId: callData.userId || callData.user || null
      });

      logger.info(`📡 Socket.IO: Call created notification sent [${callType}] ${callData.callSid}`);
    } catch (error) {
      logger.error('Failed to emit call created notification:', error);
    }
  }

  /**
   * Notify all clients that a call was updated
   * Called when call status changes, duration updates, etc.
   */
  async notifyCallUpdated(callId, updateData, callType) {
    try {
      const enriched = await this.enrichCallData(updateData);
      
      // Emit generic call update
      emitCallDetailsUpdate(callId, {
        type: 'updated',
        callType,
        data: enriched
      });

      // Emit type-specific update
      switch (callType) {
        case 'inbound':
          emitInboundCallDetailsUpdate(callId, {
            type: 'updated',
            data: enriched
          });
          break;
        case 'ivr':
          emitIVRCallDetailsUpdate(callId, {
            type: 'updated',
            data: enriched
          });
          break;
        case 'outbound':
          emitOutboundCallDetailsUpdate(callId, {
            type: 'updated',
            data: enriched
          });
          break;
      }

      // Update call list
      emitCallListUpdate(callType, {
        action: 'update',
        call: enriched
      });
      await analyticsController.handleCallEvent({
        event: 'call_updated',
        callSid: callId,
        callType,
        userId: updateData.userId || updateData.user || null
      });

      logger.info(`📡 Socket.IO: Call updated notification sent [${callType}] ${callId}`);
    } catch (error) {
      logger.error('Failed to emit call updated notification:', error);
    }
  }

  /**
   * Notify all clients that a call ended
   * Called when calls complete, fail, or are hung up
   */
  async notifyCallEnded(callId, callData, callType) {
    try {
      const enriched = await this.enrichCallData(callData);
      
      // Emit generic call update
      emitCallDetailsUpdate(callId, {
        type: 'ended',
        callType,
        data: enriched
      });

      // Emit type-specific update
      switch (callType) {
        case 'inbound':
          emitInboundCallDetailsUpdate(callId, {
            type: 'ended',
            data: enriched
          });
          break;
        case 'ivr':
          emitIVRCallDetailsUpdate(callId, {
            type: 'ended',
            data: enriched
          });
          break;
        case 'outbound':
          emitOutboundCallDetailsUpdate(callId, {
            type: 'ended',
            data: enriched
          });
          break;
      }

      // Update call list
      emitCallListUpdate(callType, {
        action: 'update',
        call: enriched
      });

      // Also emit analytics update trigger
      emitCallListUpdate('analytics', {
        action: 'refresh',
        callType,
        callId
      });
      await analyticsController.handleCallEvent({
        event: 'call_ended',
        callSid: callId,
        callType,
        userId: callData.userId || callData.user || null
      });

      logger.info(`📡 Socket.IO: Call ended notification sent [${callType}] ${callId}`);
    } catch (error) {
      logger.error('Failed to emit call ended notification:', error);
    }
  }

  /**
   * Notify that IVR node was visited during call
   * Called from IVR workflow engine when user navigates menus
   */
  async notifyIVRNodeVisited(callId, nodeData) {
    try {
      emitIVRCallDetailsUpdate(callId, {
        type: 'node_visited',
        node: nodeData,
        timestamp: new Date()
      });
      logger.info(`📡 Socket.IO: IVR node visited ${callId} - ${nodeData.nodeId}`);
    } catch (error) {
      logger.error('Failed to emit IVR node visited notification:', error);
    }
  }

  /**
   * Notify that user made selection in IVR
   * Called when user presses DTMF or makes voice selection
   */
  async notifyIVRSelection(callId, selectionData) {
    try {
      emitIVRCallDetailsUpdate(callId, {
        type: 'selection',
        selection: selectionData,
        timestamp: new Date()
      });
      logger.info(`📡 Socket.IO: IVR selection ${callId} - digit: ${selectionData.digit}`);
    } catch (error) {
      logger.error('Failed to emit IVR selection notification:', error);
    }
  }

  /**
   * Notify analytics refresh needed
   * Called when bulk operations complete or significant changes occur
   */
  notifyAnalyticsRefresh(reason = 'manual') {
    try {
      emitCallListUpdate('analytics', {
        action: 'refresh',
        reason,
        timestamp: new Date()
      });
      analyticsController.clearCache();
      analyticsController.scheduleAnalyticsBroadcast({
        period: 'today',
        reason
      });
      logger.info(`📡 Socket.IO: Analytics refresh requested - ${reason}`);
    } catch (error) {
      logger.error('Failed to emit analytics refresh:', error);
    }
  }
}

export default new CallDetailsController();
