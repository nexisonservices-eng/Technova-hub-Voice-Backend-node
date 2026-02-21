import logger from '../utils/logger.js';
import callStateService from '../services/callStateService.js';
import AIBridgeService from '../services/aiBridgeService.js';
import ttsJobQueue from '../services/ttsJobQueue.js';
import analyticsController from '../controllers/analyticsController.js';
import { setupIVRWorkflowHandlers } from './ivrWorkflowSocket.js';
import IVRWorkflowEngine from '../services/ivrWorkflowEngine.js';
import InboundCallController, { setSocketIO } from '../controllers/inboundCallController.js';

let io;
let initialized = false;
let cleanupInterval = null;

const activeConnections = new Map();
const CONNECTION_CLEANUP_INTERVAL = 30000; // 30s
const ANALYTICS_ROOM = 'analytics_room';
const CALLS_ROOM = 'calls_room';

export function initializeSocketIO(socketIo) {
  if (initialized) {
    logger.warn('⚠️ Socket.IO already initialized, skipping');
    return;
  }

  initialized = true;
  io = socketIo;

  cleanupInterval = setInterval(cleanupStaleConnections, CONNECTION_CLEANUP_INTERVAL);

  // Setup IVR Workflow handlers
  setupIVRWorkflowHandlers(io);

  // Initialize TTS job queue with Socket.IO
  ttsJobQueue.setSocketIO(io);
  logger.info('🔌 TTS Job Queue connected to Socket.IO');

  // Initialize InboundCallController with Socket.IO for IVR events
  setSocketIO(io);
  logger.info('🔌 InboundCallController connected to Socket.IO');

  io.on('connection', (socket) => {
    logger.info(`✅ Socket.io client connected: ${socket.id}`);
    activeConnections.set(socket.id, { connectedAt: Date.now(), socket });

    socket.on('join_analytics_room', async (payload = {}) => {
      try {
        socket.join(ANALYTICS_ROOM);
        logger.info(`Socket ${socket.id} joined ${ANALYTICS_ROOM}`);
        await analyticsController.emitAnalyticsSnapshotToSocket(socket, payload);
      } catch (error) {
        logger.error(`Failed analytics room join for ${socket.id}:`, error);
        socket.emit('analytics_error', { error: error.message });
      }
    });

    socket.on('leave_analytics_room', () => {
      socket.leave(ANALYTICS_ROOM);
      logger.info(`Socket ${socket.id} left ${ANALYTICS_ROOM}`);
    });

    socket.on('request_call_analytics', async (payload = {}) => {
      try {
        await analyticsController.emitAnalyticsSnapshotToSocket(socket, payload);
      } catch (error) {
        logger.error(`Failed call analytics request for ${socket.id}:`, error);
        socket.emit('analytics_error', { error: error.message });
      }
    });

    socket.on('subscribe_calls', () => {
      socket.join(CALLS_ROOM);
      logger.info(`Socket ${socket.id} joined ${CALLS_ROOM}`);
    });

    socket.on('unsubscribe_calls', () => {
      socket.leave(CALLS_ROOM);
      logger.info(`Socket ${socket.id} left ${CALLS_ROOM}`);
    });

    // IVR Workflow Execution listener
    socket.on('ivr_workflow_execution', async (data) => {
      const { callSid, workflowId, userInput } = data;

      try {
        const result = await IVRWorkflowEngine.executeStep(workflowId, userInput, callSid);

        emitIVRWorkflowUpdate(callSid, {
          workflowId,
          currentNode: result.currentNode,
          nextAction: result.action,
          response: result.response
        });

      } catch (error) {
        emitIVRWorkflowError(callSid, {
          workflowId,
          error: error.message
        });
      }
    });

    // Real-time stats request handler
    socket.on('request_ivr_stats', async () => {
      try {
        const stats = await IVRWorkflowEngine.emitWorkflowStats();
        logger.info('📊 Sent IVR stats on request');
      } catch (error) {
        logger.error('Failed to send IVR stats:', error);
      }
    });

    // IVR Configuration Analytics handlers
    socket.on('request_ivr_analytics', async () => {
      try {
        // Get IVR configuration analytics
        const { default: Workflow } = await import('../models/Workflow.js');
        
        const totalConfigs = await Workflow.countDocuments({ status: 'active' });
        const configsByType = await Workflow.aggregate([
          { $match: { status: 'active' } },
          { $group: { _id: '$config.type', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]);
        
        const ivrAnalytics = {
          totalConfigurations: totalConfigs,
          configurationsByType: configsByType,
          averageNodesPerConfig: 0,
          mostUsedNodeType: 'menu',
          lastUpdated: new Date()
        };

        socket.emit('ivr_analytics_update', ivrAnalytics);
        logger.info('📊 Sent IVR configuration analytics');
      } catch (error) {
        logger.error('Failed to send IVR analytics:', error);
        socket.emit('ivr_analytics_error', { error: error.message });
      }
    });

    socket.on('request_ivr_performance_metrics', async () => {
      try {
        const { default: ExecutionLog } = await import('../models/ExecutionLog.js');
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const performanceMetrics = await ExecutionLog.aggregate([
          {
            $match: {
              startTime: { $gte: today, $lt: tomorrow }
            }
          },
          {
            $group: {
              _id: '$workflowId',
              totalExecutions: { $sum: 1 },
              successfulExecutions: {
                $sum: {
                  $cond: { if: { $eq: ['$status', 'completed'] }, then: 1, else: 0 }
                }
              },
              averageDuration: { $avg: '$duration' },
              totalErrors: {
                $sum: {
                  $cond: { if: { $eq: ['$status', 'failed'] }, then: 1, else: 0 }
                }
              }
            }
          },
          {
            $sort: { totalExecutions: -1 }
          },
          {
            $limit: 10
          }
        ]);

        const ivrPerformance = {
          topWorkflows: performanceMetrics,
          totalExecutionsToday: performanceMetrics.reduce((sum, item) => sum + item.totalExecutions, 0),
          averageSuccessRate: performanceMetrics.length > 0 ? 
            Math.round((performanceMetrics.reduce((sum, item) => sum + item.successfulExecutions, 0) / 
                     performanceMetrics.reduce((sum, item) => sum + item.totalExecutions, 0)) * 100) : 0,
          averageDuration: performanceMetrics.length > 0 ? 
            Math.round(performanceMetrics.reduce((sum, item) => sum + item.averageDuration, 0) / performanceMetrics.length) : 0,
          timestamp: new Date()
        };

        socket.emit('ivr_performance_update', ivrPerformance);
        logger.info('📊 Sent IVR performance metrics');
      } catch (error) {
        logger.error('Failed to send IVR performance metrics:', error);
        socket.emit('ivr_performance_error', { error: error.message });
      }
    });

    // IVR Menus Request listener - send current IVR list
    socket.on('request_ivr_menus', async (data) => {
      try {
        const { default: Workflow } = await import('../models/Workflow.js');
        
        // Production-level query - only valid IVR workflows
        const ivrWorkflows = await Workflow.findActive({
          promptKey: { $exists: true, $ne: null },
          displayName: { $exists: true, $ne: null }
        })
        .select('_id promptKey displayName nodes edges config status tags createdAt updatedAt')
        .sort({ updatedAt: -1 });

        logger.info(`Retrieved ${ivrWorkflows.length} active IVR workflows`);

        // Format for frontend
        const formattedWorkflows = ivrWorkflows.map(workflow => {
          const greetingNode = workflow.nodes.find(node => node.type === 'greeting');
          const inputNodes = workflow.nodes.filter(node => node.type === 'input');
          
          return {
            _id: workflow._id,
            promptKey: workflow.promptKey,
            displayName: workflow.displayName,
            greeting: {
              text: greetingNode?.data?.text || 'Welcome',
              voice: workflow.config.voiceId,
              language: workflow.config.language
            },
            menuOptions: inputNodes.map(node => ({
              digit: node.data?.digit || '1',
              label: node.data?.label || 'Option',
              action: node.data?.action || 'transfer',
              destination: node.data?.destination || ''
            })),
            settings: {
              timeout: workflow.config.timeout,
              maxAttempts: workflow.config.maxAttempts,
              invalidInputMessage: workflow.config.invalidInputMessage
            },
            workflowConfig: {
              nodes: workflow.nodes,
              edges: workflow.edges,
              settings: workflow.config
            },
            status: workflow.status,
            tags: workflow.tags,
            nodeCount: workflow.nodeCount,
            edgeCount: workflow.edgeCount,
            isComplete: workflow.isComplete,
            createdAt: workflow.createdAt,
            updatedAt: workflow.updatedAt
          };
        });

        // Send IVR workflows list to requesting client
        socket.emit('ivr_menus_list', {
          menus: formattedWorkflows,
          timestamp: new Date().toISOString(),
          count: formattedWorkflows.length
        });

        logger.info(`📡 Sent IVR menus list to client ${socket.id}: ${formattedWorkflows.length} menus`);

      } catch (error) {
        logger.error(`Error sending IVR menus to client ${socket.id}:`, error);
        socket.emit('ivr_menus_error', {
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    socket.on('error', (error) => {
      logger.error(`❌ Socket error for ${socket.id}:`, error);
    });

    // Broadcast room
    socket.on('join_broadcast', (broadcastId) => {
      socket.join(`broadcast:${broadcastId}`);
      logger.info(`Socket ${socket.id} joined broadcast:${broadcastId}`);
    });

    socket.on('leave_broadcast', (broadcastId) => {
      socket.leave(`broadcast:${broadcastId}`);
      logger.info(`Socket ${socket.id} left broadcast:${broadcastId}`);
    });

    // Twilio AI streaming
    socket.on('twilio_media_start', async (data) => {
      const { callSid } = data;
      logger.info(`[${callSid}] Twilio media stream started`);

      const state = callStateService.getCallState(callSid);
      if (!state) {
        logger.error(`[${callSid}] Call state not found`);
        socket.emit('error', { message: 'Call state not found' });
        return;
      }

      const aiClient = new AIBridgeService(callSid);
      await aiClient.connect();

      callStateService.updateCallState(callSid, { aiClient, socketId: socket.id });

      aiClient.on('transcription', async (data) => {
        logger.info(`[${callSid}] User: ${data.text}`);
        await callStateService.addConversation(callSid, 'user', data.text);
        socket.emit('transcription', data);
      });

      aiClient.on('ai_response', async (data) => {
        logger.info(`[${callSid}] AI: ${data.text}`);
        await callStateService.addConversation(callSid, 'ai', data.text);
        socket.emit('ai_response', data);
      });

      aiClient.on('audio_response', (data) => {
        logger.info(`[${callSid}] Sending AI audio`);
        socket.emit('audio_response', {
          audio: data.audio.toString('base64'),
          format: data.format
        });
      });

      aiClient.on('error', (error) => {
        logger.error(`[${callSid}] AI error:`, error);
        socket.emit('ai_error', { error: error.message });
      });

      socket.data.aiClient = aiClient;
      socket.data.callSid = callSid;
    });

    socket.on('audio_chunk', (data) => {
      const { audioHex } = data;
      const aiClient = socket.data.aiClient;
      if (aiClient) {
        const buffer = Buffer.from(audioHex, 'hex');
        aiClient.sendAudio(buffer);
      }
    });

    socket.on('disconnect', async (reason) => {
      logger.info(`❌ Socket disconnected: ${socket.id} - Reason: ${reason}`);
      activeConnections.delete(socket.id);

      if (socket.data.aiClient) {
        try {
          socket.data.aiClient.disconnect();
          if (socket.data.callSid) await callStateService.endCall(socket.data.callSid);
        } catch (err) {
          logger.error(`❌ Cleanup error for ${socket.id}:`, err);
        }
      }
    });

    // Workflow update listener
    socket.on('workflow_update', async (data) => {
      const workflowId = data?.workflowId;
      try {
        const { workflowData } = data;
        logger.info(`Received workflow update from client ${socket.id}`, {
          workflowId,
          nodeCount: workflowData?.nodes?.length || 0
        });

        // Update workflow in database
        const { default: Workflow } = await import('../models/Workflow.js');
        
        const updateResult = await Workflow.findByIdAndUpdate(
          workflowId,
          {
            $set: {
              nodes: workflowData.nodes || [],
              edges: workflowData.edges || [],
              config: workflowData.settings || {},
              updatedAt: new Date()
            }
          },
          { new: true }
        );

        if (updateResult) {
          logger.info(`Workflow ${workflowId} updated successfully`);

          // Broadcast updated workflow to all connected clients using io instance
          const updatedWorkflow = await Workflow.findById(workflowId);
          if (updatedWorkflow) {
            const formattedWorkflow = {
              _id: updatedWorkflow._id,
              promptKey: updatedWorkflow.promptKey,
              displayName: updatedWorkflow.displayName,
              greeting: {
                text: updatedWorkflow.nodes?.find(n => n.type === 'greeting')?.data?.text || 'Welcome',
                voice: updatedWorkflow.config?.voiceId || 'en-GB-SoniaNeural',
                language: updatedWorkflow.config?.language || 'en-GB'
              },
              menuOptions: updatedWorkflow.nodes?.filter(n => n.type === 'input').map(n => ({
                digit: n.data?.digit || '1',
                label: n.data?.label || 'Option',
                action: n.data?.action || 'transfer',
                destination: n.data?.destination || ''
              })),
              settings: {
                timeout: updatedWorkflow.config?.timeout || 10,
                maxAttempts: updatedWorkflow.config?.maxAttempts || 3,
                invalidInputMessage: updatedWorkflow.config?.invalidInputMessage || 'Invalid selection. Please try again.'
              },
              workflowConfig: {
                nodes: updatedWorkflow.nodes || [],
                edges: updatedWorkflow.edges || [],
                settings: updatedWorkflow.config || {}
              },
              status: updatedWorkflow.status || 'draft',
              tags: updatedWorkflow.tags || [],
              nodeCount: updatedWorkflow.nodeCount,
              edgeCount: updatedWorkflow.edgeCount,
              isComplete: updatedWorkflow.isComplete,
              createdAt: updatedWorkflow.createdAt,
              updatedAt: updatedWorkflow.updatedAt
            };

            // Broadcast to all connected clients using io instance
            io.emit('workflow_updated', {
              workflowId: workflowId,
              workflowData: formattedWorkflow,
              timestamp: new Date().toISOString()
            });

            logger.info(`📡 Broadcasted workflow update to all clients for workflow ${workflowId}`);
          }
        } else {
          logger.error(`❌ Failed to update workflow ${workflowId}: Workflow not found`);
        }
      } catch (error) {
        logger.error(`Error handling workflow update from client ${socket.id}:`, error);
        
        // Send error back to the requesting client using their socket
        socket.emit('workflow_error', {
          workflowId,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });
  });

  logger.info('✅ Unified Socket.IO server initialized');
}

// Cleanup stale connections
function cleanupStaleConnections() {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000;

  for (const [socketId, conn] of activeConnections.entries()) {
    if (now - conn.connectedAt > staleThreshold) {
      const socket = conn.socket;
      if (!socket.connected) {
        activeConnections.delete(socketId);
        logger.info(`🧹 Cleaned up stale connection: ${socketId}`);
      }
    }
  }
}

// 🔹 Broadcast / call emit helpers
export function emitBroadcastUpdate(broadcastId, data) {
  if (!io) return;
  io.to(`broadcast:${broadcastId}`).emit('broadcast_update', {
    broadcastId,
    timestamp: new Date(),
    ...data
  });
}

export function emitCallUpdate(broadcastId, callData) {
  if (!io) return;
  io.to(`broadcast:${broadcastId}`).emit('call_update', {
    broadcastId,
    timestamp: new Date(),
    ...callData
  });
  io.emit('outbound_call_update', {
    broadcastId,
    timestamp: new Date(),
    ...callData
  });
}

export function emitCallsCreated(broadcastId) {
  if (!io) return;
  io.to(`broadcast:${broadcastId}`).emit('calls_created', {
    broadcastId,
    timestamp: new Date()
  });
}

export function emitBroadcastListUpdate() {
  if (!io) return;
  io.emit('broadcast_list_update', { timestamp: new Date() });
}

export function emitBatchUpdate(broadcastId, batchData) {
  if (!io) return;
  io.to(`broadcast:${broadcastId}`).emit('batch_update', {
    broadcastId,
    timestamp: new Date(),
    calls: batchData
  });
}

export function emitActiveCalls(calls) {
  if (!io) return;
  io.emit('calls_update', { calls });
}

export function emitStatsUpdate(stats) {
  if (!io) return;
  io.emit('stats_update', stats);
}

export function emitHealthUpdate(health) {
  if (!io) return;
  io.emit('health_update', health);
}

// 🔹 Inbound call emit helpers
export function emitInboundCallUpdate(callData) {
  if (!io) return;
  io.emit('inbound_call_update', {
    timestamp: new Date(),
    ...callData
  });
  io.emit('inbound_data_updated', {
    timestamp: new Date(),
    ...callData
  });
}

export function emitQueueUpdate(queueData) {
  if (!io) return;
  io.emit('queue_update', {
    timestamp: new Date(),
    ...queueData
  });
  io.emit('queue_status_updated', {
    timestamp: new Date(),
    ...queueData
  });
}

export function emitIVRUpdate(callSid, ivrData) {
  if (!io) return;
  io.emit('ivr_update', {
    callSid,
    timestamp: new Date(),
    ...ivrData
  });
}

export function emitCallbackUpdate(callbackData) {
  if (!io) return;
  io.emit('callback_update', {
    timestamp: new Date(),
    ...callbackData
  });
}

// 🔹 IVR Workflow emit helpers
export function emitIVRWorkflowUpdate(callSid, data) {
  if (!io) return;
  io.emit('ivr_workflow_update', {
    callSid,
    timestamp: new Date(),
    ...data
  });
}

export function emitIVRWorkflowError(callSid, data) {
  if (!io) return;
  io.emit('ivr_workflow_error', {
    callSid,
    timestamp: new Date(),
    ...data
  });
}

export function emitIVRWorkflowStats(stats) {
  if (!io) return;
  io.emit('ivr_workflow_stats', {
    timestamp: new Date(),
    ...stats
  });
}

export function getSocketIO() {
  return io;
}

export function getIO() {
  return io;
}

// 🔹 Call Details emit helpers
export function emitCallDetailsUpdate(callId, callData) {
  if (!io) return;
  io.emit('call_details_update', {
    callId,
    timestamp: new Date(),
    ...callData
  });
  io.emit('call_updated', {
    callId,
    timestamp: new Date(),
    ...callData
  });
}

export function emitInboundCallDetailsUpdate(callId, callData) {
  if (!io) return;
  io.emit('inbound_call_details_update', {
    callId,
    timestamp: new Date(),
    ...callData
  });
}

export function emitIVRCallDetailsUpdate(callId, callData) {
  if (!io) return;
  io.emit('ivr_call_details_update', {
    callId,
    timestamp: new Date(),
    ...callData
  });
}

export function emitOutboundCallDetailsUpdate(callId, callData) {
  if (!io) return;
  io.emit('outbound_call_details_update', {
    callId,
    timestamp: new Date(),
    ...callData
  });
}

export function emitCallListUpdate(callType, callsData) {
  if (!io) return;
  io.emit('call_list_update', {
    callType,
    timestamp: new Date(),
    ...callsData
  });
  io.emit('call_updated', {
    callType,
    timestamp: new Date(),
    ...callsData
  });
}

export function shutdownSocketIO() {

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info('🛑 Socket.IO cleanup interval cleared');
  }

  if (io) {
    io.removeAllListeners();
    io = null;
    initialized = false;
    logger.info('🛑 Socket.IO shut down cleanly');
  }
}

