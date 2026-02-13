import logger from '../utils/logger.js';
import IVRWorkflowEngine from '../services/ivrWorkflowEngine.js';
import Workflow from '../models/Workflow.js';

export function setupIVRWorkflowHandlers(io) {

  io.on('connection', (socket) => {

    // Join workflow editing room
    socket.on('join_workflow', (workflowId) => {
      socket.join(`workflow:${workflowId}`);
      logger.info(`Socket ${socket.id} joined workflow:${workflowId}`);

      // Notify other users
      socket.to(`workflow:${workflowId}`).emit('workflow_user_joined', {
        userId: socket.id,
        timestamp: new Date()
      });
    });

    // Leave workflow editing room
    socket.on('leave_workflow', (workflowId) => {
      socket.leave(`workflow:${workflowId}`);
      socket.to(`workflow:${workflowId}`).emit('workflow_user_left', {
        userId: socket.id,
        timestamp: new Date()
      });
    });

    // Real-time workflow editing
    socket.on('workflow_node_add', async (data) => {
      const { workflowId, node, position } = data;

      try {
        const result = await IVRWorkflowEngine.addNode(workflowId, node, position);

        io.to(`workflow:${workflowId}`).emit('workflow_node_added', {
          workflowId,
          node: result.newNode,
          addedBy: socket.id,
          timestamp: new Date()
        });

        logger.info(`Node added to workflow ${workflowId} by ${socket.id}`);
      } catch (error) {
        socket.emit('workflow_error', { error: error.message });
      }
    });

    socket.on('workflow_node_update', async (data) => {
      const { workflowId, nodeId, data: nodeData } = data;
      try {
        // Update in DB (optional if you want to wait for save)
        const updatedNode = await IVRWorkflowEngine.updateNodeData(workflowId, nodeId, nodeData);

        io.to(`workflow:${workflowId}`).emit('workflow_node_updated', {
          workflowId,
          nodeId,
          data: updatedNode.data,
          audioUrl: updatedNode.audioUrl,
          audioAssetId: updatedNode.audioAssetId,
          updatedBy: socket.id,
          timestamp: new Date()
        });
      } catch (error) {
        socket.emit('workflow_error', { error: error.message });
      }
    });

    socket.on('workflow_node_move', async (data) => {
      const { workflowId, nodeId, position } = data;

      try {
        await IVRWorkflowEngine.moveNode(workflowId, nodeId, position);

        io.to(`workflow:${workflowId}`).emit('workflow_node_moved', {
          workflowId,
          nodeId,
          position,
          movedBy: socket.id,
          timestamp: new Date()
        });
      } catch (error) {
        socket.emit('workflow_error', { error: error.message });
      }
    });

    socket.on('workflow_edge_connect', async (data) => {
      const { workflowId, sourceNode, targetNode, sourceHandle, targetHandle, edgeId } = data;

      try {
        const edge = await IVRWorkflowEngine.connectNodes(
          workflowId, sourceNode, targetNode, sourceHandle, targetHandle, edgeId
        );

        io.to(`workflow:${workflowId}`).emit('workflow_edge_connected', {
          workflowId,
          edge,
          connectedBy: socket.id,
          timestamp: new Date()
        });
      } catch (error) {
        socket.emit('workflow_error', { error: error.message });
      }
    });

    socket.on('workflow_edge_delete', async (data) => {
      const { workflowId, edgeId } = data;
      try {
        await IVRWorkflowEngine.deleteEdge(workflowId, edgeId);
        io.to(`workflow:${workflowId}`).emit('workflow_edge_deleted', {
          workflowId,
          edgeId,
          deletedBy: socket.id,
          timestamp: new Date()
        });
      } catch (error) {
        socket.emit('workflow_error', { error: error.message });
      }
    });

    socket.on('workflow_edge_reattach', async (data) => {
      const { workflowId, edgeId, updates } = data;
      try {
        const edge = await IVRWorkflowEngine.reattachEdge(workflowId, edgeId, updates);
        io.to(`workflow:${workflowId}`).emit('workflow_edge_reattached', {
          workflowId,
          edge,
          updatedBy: socket.id,
          timestamp: new Date()
        });
      } catch (error) {
        socket.emit('workflow_error', { error: error.message });
      }
    });

    socket.on('workflow_edge_update', async (data) => {
      const { workflowId, edgeId, updates } = data;
      try {
        const edge = await IVRWorkflowEngine.updateEdge(workflowId, edgeId, updates);
        io.to(`workflow:${workflowId}`).emit('workflow_edge_updated', {
          workflowId,
          edge,
          updatedBy: socket.id,
          timestamp: new Date()
        });
      } catch (error) {
        socket.emit('workflow_error', { error: error.message });
      }
    });

    socket.on('workflow_node_delete', async (data) => {
      const { workflowId, nodeId } = data;
      try {
        await IVRWorkflowEngine.deleteNode(workflowId, nodeId);
        io.to(`workflow:${workflowId}`).emit('workflow_node_deleted', {
          workflowId,
          nodeId,
          deletedBy: socket.id,
          timestamp: new Date()
        });
      } catch (error) {
        socket.emit('workflow_error', { error: error.message });
      }
    });

    // Live workflow testing
    socket.on('workflow_test_start', async (data) => {
      const { workflowId, testScenario } = data;

      try {
        const workflow = await Workflow.findById(workflowId).lean();
        if (!workflow) {
          throw new Error('Workflow not found');
        }

        const testSession = {
          id: `test_${Date.now()}`,
          workflow,
          scenario: testScenario || {},
          startedAt: new Date()
        };
        socket.join(`test:${workflowId}`);

        socket.emit('workflow_test_started', {
          testId: testSession.id,
          workflowId,
          timestamp: new Date()
        });

        await simulateWorkflowTest(io, workflowId, testSession);

      } catch (error) {
        socket.emit('workflow_test_error', { error: error.message });
      }
    });

    // Industry-specific service requests
    socket.on('industry_service_request', async (data) => {
      const { industry, serviceType, requestData, callSid } = data;

      try {
        const serviceResponse = await IVRWorkflowEngine.processIndustryService(
          industry, serviceType, requestData, callSid
        );

        socket.emit('industry_service_response', {
          industry,
          serviceType,
          response: serviceResponse,
          callSid,
          timestamp: new Date()
        });

        io.emit('industry_service_processed', {
          industry,
          serviceType,
          callSid,
          success: serviceResponse.success,
          timestamp: new Date()
        });

      } catch (error) {
        socket.emit('industry_service_error', {
          error: error.message,
          industry,
          serviceType
        });
      }
    });
  });
}

async function simulateWorkflowTest(io, workflowId, testSession) {
  const nodes = Array.isArray(testSession.workflow?.nodes) ? testSession.workflow.nodes : [];

  if (nodes.length === 0) {
    io.to(`test:${workflowId}`).emit('workflow_test_completed', {
      testId: testSession.id,
      workflowId,
      success: false,
      error: 'Workflow has no nodes',
      timestamp: new Date()
    });
    return;
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    io.to(`test:${workflowId}`).emit('workflow_test_node', {
      testId: testSession.id,
      workflowId,
      nodeIndex: i,
      nodeId: node.id,
      nodeType: node.type,
      status: 'processing',
      timestamp: new Date()
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    io.to(`test:${workflowId}`).emit('workflow_test_node', {
      testId: testSession.id,
      workflowId,
      nodeIndex: i,
      nodeId: node.id,
      nodeType: node.type,
      status: 'completed',
      timestamp: new Date()
    });
  }

  io.to(`test:${workflowId}`).emit('workflow_test_completed', {
    testId: testSession.id,
    workflowId,
    success: true,
    timestamp: new Date()
  });
}
