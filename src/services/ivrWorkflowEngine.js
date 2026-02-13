import Workflow from '../models/Workflow.js';
import ExecutionLog from '../models/ExecutionLog.js';
import logger from '../utils/logger.js';
import twilio from 'twilio';
import EventEmitter from 'events';
import ivrExecutionEngine from './ivrExecutionEngine.js';
import { emitIVRWorkflowUpdate, emitIVRWorkflowError, emitIVRWorkflowStats } from '../sockets/unifiedSocket.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Production-grade IVR Workflow Engine with stateful execution tracking,
 * loop detection, timeout protection, and comprehensive error handling
 */
class IVRWorkflowEngine extends EventEmitter {
    constructor() {
        super();

        // Execution state tracking
        this.activeExecutions = new Map(); // callSid -> ExecutionState

        // Safety limits
        this.MAX_LOOP_ITERATIONS = 50;
        this.MAX_NODE_EXECUTIONS = 200;
        this.EXECUTION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

        // Cleanup interval: every hour
        setInterval(() => this.cleanupStaleExecutions(), 60 * 60 * 1000);
    }

    /**
     * Start a new workflow execution
     */
    async startExecution(workflowId, callSid, callerNumber, destinationNumber) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            // Create execution log in database
            const executionLog = new ExecutionLog({
                callSid,
                workflowId,
                workflowName: workflow.promptKey,
                callerNumber,
                destinationNumber,
                startTime: new Date(),
                status: 'running'
            });
            await executionLog.save();

            // Create in-memory execution state
            const executionState = {
                callSid,
                workflowId,
                executionLogId: executionLog._id,
                startTime: Date.now(),
                currentNodeId: null,
                visitedNodes: [],
                variables: {},
                nodeAttempts: {},
                loopIterations: 0,
                nodeExecutionCount: 0,
                lastNodeTime: Date.now()
            };

            this.activeExecutions.set(callSid, executionState);

            this.emit('execution:started', { callSid, workflowId });
            
            // Emit real-time analytics
            emitIVRWorkflowUpdate(callSid, {
                event: 'execution_started',
                workflowId,
                workflowName: workflow.promptKey,
                callerNumber,
                destinationNumber,
                timestamp: new Date()
            });
            
            // Update overall stats
            this.emitWorkflowStats();
            
            logger.info(`✅ Execution started: ${callSid} for workflow ${workflowId}`);

            return executionLog;
        } catch (error) {
            logger.error('âŒ Failed to start execution:', error);
            throw error;
        }
    }

    /**
     * Get execution state for a call
     */
    getExecutionState(callSid) {
        return this.activeExecutions.get(callSid);
    }

    /**
     * Track node visit and check for safety violations
     */
    async trackNodeVisit(callSid, nodeId, nodeType, userInput = null) {
        const state = this.getExecutionState(callSid);
        if (!state) {
            logger.warn(`âš ï¸ No execution state found for ${callSid}`);
            return { allowed: true };
        }

        // Check timeout
        const elapsedTime = Date.now() - state.startTime;
        if (elapsedTime > this.EXECUTION_TIMEOUT_MS) {
            await this.endExecution(callSid, 'timeout');
            return {
                allowed: false,
                reason: 'timeout',
                message: 'Execution timeout exceeded'
            };
        }

        // Check max node executions
        state.nodeExecutionCount++;
        if (state.nodeExecutionCount > this.MAX_NODE_EXECUTIONS) {
            await this.endExecution(callSid, 'max_iterations');
            return {
                allowed: false,
                reason: 'max_nodes',
                message: 'Maximum node executions exceeded'
            };
        }

        // Check for loops
        const recentVisits = state.visitedNodes.slice(-10);
        const nodeVisitCount = recentVisits.filter(v => v.nodeId === nodeId).length;
        if (nodeVisitCount >= 5) {
            state.loopIterations++;
            if (state.loopIterations > this.MAX_LOOP_ITERATIONS) {
                await this.endExecution(callSid, 'max_iterations');
                return {
                    allowed: false,
                    reason: 'loop_detected',
                    message: 'Loop iteration limit exceeded'
                };
            }
        }

        // Track visit
        state.visitedNodes.push({
            nodeId,
            nodeType,
            timestamp: new Date(),
            userInput
        });
        state.currentNodeId = nodeId;
        state.lastNodeTime = Date.now();

        // Update database log
        try {
            const log = await ExecutionLog.findById(state.executionLogId);
            if (log) {
                await log.recordNodeVisit(nodeId, nodeType, userInput);
            }
        } catch (error) {
            logger.error('Failed to update execution log:', error);
        }

        this.emit('node:visited', { callSid, nodeId, nodeType });
        
        // Emit real-time node analytics
        emitIVRWorkflowUpdate(callSid, {
            event: 'node_visited',
            nodeId,
            nodeType,
            userInput,
            timestamp: new Date(),
            executionStats: {
                nodeExecutionCount: state.nodeExecutionCount,
                loopIterations: state.loopIterations,
                visitedNodes: state.visitedNodes.length
            }
        });

        return { allowed: true };
    }

    /**
     * Set a variable in execution context
     */
    setVariable(callSid, key, value) {
        const state = this.getExecutionState(callSid);
        if (state) {
            state.variables[key] = value;
            this.emit('variable:set', { callSid, key, value });
        }
    }

    /**
     * Get a variable from execution context
     */
    getVariable(callSid, key) {
        const state = this.getExecutionState(callSid);
        return state ? state.variables[key] : undefined;
    }

    /**
     * Replace variables in text with actual values
     */
    replaceVariables(callSid, text) {
        const state = this.getExecutionState(callSid);
        if (!state || !text) return text;

        let result = text;
        for (const [key, value] of Object.entries(state.variables)) {
            const pattern = new RegExp(`\\$\\{${key}\\}|\\$${key}\\b`, 'g');
            result = result.replace(pattern, value);
        }
        return result;
    }

    /**
     * End execution
     */
    async endExecution(callSid, reason = 'normal', errorMessage = null) {
        const state = this.activeExecutions.get(callSid);
        if (!state) return;

        try {
            // Update database log
            const log = await ExecutionLog.findById(state.executionLogId);
            if (log) {
                log.endTime = new Date();
                log.duration = log.endTime - log.startTime;
                log.status = errorMessage ? 'failed' : (reason === 'timeout' ? 'timeout' : 'completed');
                log.reason = reason;
                log.nodeExecutionCount = state.nodeExecutionCount;
                log.loopIterations = state.loopIterations;
                log.variables = state.variables;
                if (errorMessage) log.errorMessage = errorMessage;
                await log.save();
            }

            // Remove from active executions
            this.activeExecutions.delete(callSid);

            this.emit('execution:ended', { callSid, reason });
            
            // Emit real-time completion analytics
            emitIVRWorkflowUpdate(callSid, {
                event: 'execution_ended',
                reason,
                duration: Date.now() - state.startTime,
                nodeExecutionCount: state.nodeExecutionCount,
                loopIterations: state.loopIterations,
                timestamp: new Date()
            });
            
            // Update overall stats
            this.emitWorkflowStats();
            
            logger.info(`🏁 Execution ended: ${callSid} (reason: ${reason})`);
        } catch (error) {
            logger.error('Failed to end execution:', error);
        }
    }

    /**
     * Emit real-time workflow statistics
     */
    async emitWorkflowStats() {
        try {
            const stats = {
                activeExecutions: this.activeExecutions.size,
                totalExecutionsToday: await this.getTodayExecutionCount(),
                averageExecutionTime: await this.getAverageExecutionTime(),
                successRate: await this.getSuccessRate(),
                nodeTypeDistribution: await this.getNodeTypeDistribution(),
                timestamp: new Date()
            };
            
            emitIVRWorkflowStats(stats);
        } catch (error) {
            logger.error('Failed to emit workflow stats:', error);
        }
    }

    /**
     * Get today's execution count
     */
    async getTodayExecutionCount() {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            
            const count = await ExecutionLog.countDocuments({
                startTime: { $gte: today, $lt: tomorrow }
            });
            
            return count;
        } catch (error) {
            logger.error('Error getting today execution count:', error);
            return 0;
        }
    }

    /**
     * Get average execution time
     */
    async getAverageExecutionTime() {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            
            const result = await ExecutionLog.aggregate([
                {
                    $match: {
                        startTime: { $gte: today, $lt: tomorrow },
                        duration: { $exists: true }
                    }
                },
                {
                    $group: {
                        _id: null,
                        avgDuration: { $avg: '$duration' }
                    }
                }
            ]);
            
            return result.length > 0 ? Math.round(result[0].avgDuration / 1000) : 0; // Convert to seconds
        } catch (error) {
            logger.error('Error getting average execution time:', error);
            return 0;
        }
    }

    /**
     * Get success rate
     */
    async getSuccessRate() {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            
            const total = await ExecutionLog.countDocuments({
                startTime: { $gte: today, $lt: tomorrow }
            });
            
            if (total === 0) return 0;
            
            const completed = await ExecutionLog.countDocuments({
                startTime: { $gte: today, $lt: tomorrow },
                status: 'completed'
            });
            
            return Math.round((completed / total) * 100);
        } catch (error) {
            logger.error('Error getting success rate:', error);
            return 0;
        }
    }

    /**
     * Get node type distribution
     */
    async getNodeTypeDistribution() {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            
            const result = await ExecutionLog.aggregate([
                {
                    $match: {
                        startTime: { $gte: today, $lt: tomorrow }
                    }
                },
                { $unwind: '$nodeVisits' },
                {
                    $group: {
                        _id: '$nodeVisits.nodeType',
                        count: { $sum: 1 }
                    }
                }
            ]);
            
            const distribution = {};
            result.forEach(item => {
                distribution[item._id] = item.count;
            });
            
            return distribution;
        } catch (error) {
            logger.error('Error getting node type distribution:', error);
            return {};
        }
    }

    /**
     * Cleanup stale executions (running > timeout)
     */
    async cleanupStaleExecutions() {
        const now = Date.now();
        const staleCallSids = [];

        for (const [callSid, state] of this.activeExecutions.entries()) {
            if (now - state.startTime > this.EXECUTION_TIMEOUT_MS) {
                staleCallSids.push(callSid);
            }
        }

        for (const callSid of staleCallSids) {
            await this.endExecution(callSid, 'timeout');
        }

        if (staleCallSids.length > 0) {
            logger.info(`ðŸ§¹ Cleaned up ${staleCallSids.length} stale executions`);
        }
    }


    /**
     * Generate TwiML for a specific node in a workflow
     */
    async generateTwiML(workflowId, nodeId, userInput = null, callSid = null) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            // Workflow model has nodes/edges directly, not in workflowConfig
            const nodes = workflow.nodes || [];
            const edges = workflow.edges || [];

            const node = nodes.find(n => n.id === nodeId);
            if (!node) throw new Error(`Node ${nodeId} not found in workflow`);

            let context = { variables: {}, lastNodeId: null };

            // Track node visit and safety checks
            if (callSid) {
                const safety = await this.trackNodeVisit(callSid, nodeId, node.type, userInput);
                if (!safety.allowed) {
                    const response = new VoiceResponse();
                    response.say({ voice: 'alice' }, safety.message || 'Error occurred.');
                    response.hangup();
                    await this.endExecution(callSid, safety.reason);
                    return response.toString();
                }

                // Get execution state for variables
                const state = this.getExecutionState(callSid);
                if (state) {
                    context.variables = state.variables;
                    context.callSid = callSid;
                    context.callerNumber = state.callerNumber; // If we stored it
                    context.nodeAttempts = state.nodeAttempts || {};
                    if (state.visitedNodes && state.visitedNodes.length > 1) {
                        const previous = state.visitedNodes[state.visitedNodes.length - 2];
                        context.lastNodeId = previous?.nodeId || null;
                    }
                }
            }

            // Replace variables in node data (if needed before execution)
            // Note: Some nodes like API_CALL might need raw variables. 
            // Better to let ExecutionEngine handle replacement or pass both.
            // For simple text replacement:
            if (node.data && node.data.text && callSid) {
                // Clone data to avoid mutating database object reference in memory
                node.data = { ...node.data, text: this.replaceVariables(callSid, node.data.text) };
            }

            // Delegate to Execution Engine
            logger.info(`Delegating execution for node ${node.type} (${nodeId})`);
            const workflowConfig = {
                nodes: workflow?.nodes || [],
                edges: workflow?.edges || [],
                settings: workflow?.config || {},
                _id: workflow._id,
                workflowId: workflow._id
            };
            return await ivrExecutionEngine.executeNode(node, context, workflowConfig, callSid);

        } catch (error) {
            logger.error('Error generating TwiML:', error);
            
            // Emit real-time error analytics
            if (callSid) {
                emitIVRWorkflowError(callSid, {
                    event: 'twiml_generation_error',
                    nodeId,
                    error: error.message,
                    timestamp: new Date()
                });
                await this.endExecution(callSid, 'error', error.message);
            }
            throw error;
        }
    }

    /**
     * Find next node and append it to TwiML if applicable (non-blocking nodes)
     */
    appendNextStep(response, workflow, currentNodeId, handle = null) {
        // Initialize workflow structure if it doesn't exist
        if (!workflow.nodes) {
            workflow.nodes = [];
        }
        if (!workflow.edges) {
            workflow.edges = [];
        }
        if (!workflow.config) {
            workflow.config = {
                timeout: 10,
                maxRetries: 3,
                language: 'en-GB',
                voice: 'en-GB-SoniaNeural'
            }
        };

        const edge = (workflow.edges || []).find(e =>
            e.source === currentNodeId && (!handle || e.sourceHandle === handle)
        );

        if (edge) {
            response.redirect(`/ivr/next-step?workflowId=${workflow._id}&currentNodeId=${edge.target}`);
        }
    }

    /**
     * Handle user input for a node
     */
    async handleUserInput(workflowId, currentNodeId, userInput, callSid = null) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            const edges = (workflow.edges || []).filter(e => e.source === currentNodeId);
            const currentNode = (workflow.nodes || []).find(n => n.id === currentNodeId);

            // Record user input
            if (callSid) {
                const state = this.getExecutionState(callSid);
                if (state) {
                    state.nodeAttempts = state.nodeAttempts || {};
                    state.nodeAttempts[currentNodeId] = (state.nodeAttempts[currentNodeId] || 0) + 1;
                    const log = await ExecutionLog.findById(state.executionLogId);
                    if (log) {
                        await log.recordUserInput(currentNodeId, userInput);
                    }
                }
            }

            const settings = workflow.config || {};
            const maxRetries = currentNode?.data?.maxRetries || settings.maxRetries || settings.maxAttempts || 3;
            const attemptCount = this.getExecutionState(callSid)?.nodeAttempts?.[currentNodeId] || 1;

            // Timeout (no digits)
            if (!userInput) {
                const timeoutEdge = edges.find(e => e.sourceHandle === 'timeout');
                if (timeoutEdge) return timeoutEdge.target;
                if (attemptCount < maxRetries) return currentNodeId;
                const fallback = edges.find(e => e.sourceHandle === 'no_match' || e.sourceHandle === 'default');
                return fallback ? fallback.target : null;
            }

            // Find edge matching userInput (digit)
            const edge = edges.find(e => e.sourceHandle === userInput || e.data?.digit === userInput);
            if (edge) return edge.target;

            // Invalid input
            if (attemptCount < maxRetries) return currentNodeId;
            const fallbackEdge = edges.find(e => e.sourceHandle === 'no_match' || e.sourceHandle === 'default');
            return fallbackEdge ? fallbackEdge.target : null;
        } catch (error) {
            logger.error('Error handling user input:', error);
            throw error;
        }
    }

    async getNextNodeByHandle(workflowId, currentNodeId, handle) {
        const workflow = await Workflow.findById(workflowId);
        if (!workflow) throw new Error('Workflow not found');
        const edge = workflow.edges.find(e =>
            e.source === currentNodeId && e.sourceHandle === handle
        );
        return edge ? edge.target : null;
    }

    /**
 * CRUD operations for workflow editing
 */
    async updateNodeData(workflowId, nodeId, nodeData) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            const nodeIndex = workflow.nodes.findIndex(n => n.id === nodeId);
            if (nodeIndex === -1) throw new Error('Node not found');

            const currentNode = workflow.nodes[nodeIndex];
            const updatedData = {
                ...currentNode.data,
                ...nodeData
            };

            // Auto-generate audio for nodes that support TTS
            const nodeType = currentNode.type;
            if (['message', 'menu', 'prompt', 'greeting', 'audio'].includes(nodeType)) {
                try {
                    const workflowAudioService = (await import('./workflowAudioService.js')).default;

                    // Update the node data first
                    workflow.nodes[nodeIndex].data = updatedData;

                    // Use the new workflowAudioService to generate audio
                    await workflowAudioService.preGenerateWorkflowAudio(workflow);

                    logger.info(`Audio generated for node ${nodeId}`);
                } catch (error) {
                    logger.error(`Failed to auto-generate audio for node ${nodeId}:`, error);
                    // Don't fail the update, just continue without audio
                }
            }

            workflow.nodes[nodeIndex].data = updatedData;
            await workflow.save();

            return workflow.nodes[nodeIndex];
        } catch (error) {
            logger.error('Error updating node data:', error);
            throw error;
        }
    }

    /**
     * Update full workflow configuration
     */
    async updateWorkflow(workflowId, workflowData) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            // Update configuration fields
            if (workflowData.nodes) workflow.nodes = workflowData.nodes;
            if (workflowData.edges) workflow.edges = workflowData.edges;
            if (workflowData.settings) {
                workflow.config = {
                    ...workflow.config,
                    ...workflowData.settings
                };
            }

            // Save workflow (triggers pre-save validation)
            // Default to completed, will be set to pending if TTS is needed
            workflow.ttsStatus = 'completed';

            // Enqueue background TTS job for nodes that need audio
            const nodesNeedingAudio = workflow.nodes.filter(node => {
                const nodeTypes = ['message', 'menu', 'prompt', 'greeting', 'audio'];
                const data = node.data || {};
                // Check if node type supports TTS, has text, AND doesn't already have audio
                // This makes the process idempotent - hitting save twice won't regenerate existing audio
                return nodeTypes.includes(node.type) &&
                    (data.text || data.message || data.prompt || data.messageText) &&
                    !data.audioUrl;
            });

            if (nodesNeedingAudio.length > 0) {
                try {
                    const ttsJobQueue = (await import('./ttsJobQueue.js')).default;
                    // ✅ Fire-and-forget background job (Fixes 30s timeout)
                    // The job queue handles processing asynchronously
                    await ttsJobQueue.addJob(workflowId, nodesNeedingAudio, false);

                    // Set status to pending since job is queued
                    workflow.ttsStatus = 'pending';
                    logger.info(`✅ Queued background TTS job for ${nodesNeedingAudio.length} nodes in workflow ${workflowId}`);
                } catch (queueError) {
                    logger.error(`❌ Failed to queue TTS job for workflow ${workflowId}:`, queueError);
                    workflow.ttsStatus = 'failed';
                    // Don't fail the save, just log the error
                }
            }

            await workflow.save();

            return workflow;
        } catch (error) {
            logger.error(`❌ Error in updateWorkflow for ${workflowId}:`, error);
            throw error;
        }
    }

    async addNode(workflowId, node, position) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            // Initialize nodes array if it doesn't exist
            if (!workflow.nodes) {
                workflow.nodes = [];
            }

            const newNode = {
                ...node,
                position,
                audioUrl: null,
                audioAssetId: null
            };
            workflow.nodes.push(newNode);
            await workflow.save();

            return { workflow, newNode };
        } catch (error) {
            logger.error('Error adding node:', error);
            throw error;
        }
    }

    async moveNode(workflowId, nodeId, position) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            const nodeIndex = workflow.nodes.findIndex(n => n.id === nodeId);
            if (nodeIndex === -1) throw new Error('Node not found');

            workflow.nodes[nodeIndex].position = position;
            await workflow.save();

            return workflow;
        } catch (error) {
            logger.error('Error moving node:', error);
            throw error;
        }
    }

    async connectNodes(workflowId, sourceNode, targetNode, sourceHandle, targetHandle, edgeId = null) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            const newEdge = {
                id: edgeId || `e-${sourceNode}-${targetNode}-${Date.now()}`,
                source: sourceNode,
                target: targetNode,
                sourceHandle,
                targetHandle
            };

            workflow.edges.push(newEdge);
            await workflow.save();

            return newEdge;
        } catch (error) {
            logger.error('Error connecting nodes:', error);
            throw error;
        }
    }

    async deleteEdge(workflowId, edgeId) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            const beforeCount = workflow.edges.length;
            workflow.edges = workflow.edges.filter(e => e.id !== edgeId);
            if (workflow.edges.length === beforeCount) {
                throw new Error('Edge not found');
            }

            await workflow.save();
            return workflow;
        } catch (error) {
            logger.error('Error deleting edge:', error);
            throw error;
        }
    }

    async reattachEdge(workflowId, edgeId, updates = {}) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            const edgeIndex = workflow.edges.findIndex(e => e.id === edgeId);
            if (edgeIndex === -1) throw new Error('Edge not found');

            workflow.edges[edgeIndex] = {
                ...workflow.edges[edgeIndex],
                ...updates
            };

            await workflow.save();
            return workflow.edges[edgeIndex];
        } catch (error) {
            logger.error('Error reattaching edge:', error);
            throw error;
        }
    }

    async updateEdge(workflowId, edgeId, updates = {}) {
        return this.reattachEdge(workflowId, edgeId, updates);
    }

    async deleteNode(workflowId, nodeId) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            workflow.nodes = workflow.nodes.filter(n => n.id !== nodeId);
            workflow.edges = workflow.edges.filter(e => e.source !== nodeId && e.target !== nodeId);

            await workflow.save();
            return workflow;
        } catch (error) {
            logger.error('Error deleting node:', error);
            throw error;
        }
    }

    /**
     * Validate workflow graph (structural + execution safety)
     */
    validateWorkflowGraph(workflow) {
        const errors = [];

        // Defensive: ensure workflow exists and has nodes
        if (!workflow) {
            errors.push({ code: 'NO_WORKFLOW', message: 'Workflow is required.' });
            return errors;
        }

        // Safely extract nodes and edges with multiple fallbacks
        const workflowNodes = workflow && workflow.nodes ? workflow.nodes : [];
        const workflowEdges = workflow && workflow.edges ? workflow.edges : [];

        const nodes = Array.isArray(workflowNodes) ? workflowNodes : [];
        const edges = Array.isArray(workflowEdges) ? workflowEdges : [];

        if (nodes.length === 0) {
            errors.push({ code: 'NO_NODES', message: 'Workflow must contain at least one node.' });
            return errors;
        }

        const nodeIds = new Set(nodes.map(n => n.id));
        const incomingCount = new Map(nodes.map(n => [n.id, 0]));

        // Broken connections and incoming counts
        edges.forEach(edge => {
            if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
                errors.push({
                    code: 'BROKEN_EDGE',
                    message: `Edge ${edge.id} references missing node(s).`,
                    edgeId: edge.id
                });
                return;
            }
            incomingCount.set(edge.target, (incomingCount.get(edge.target) || 0) + 1);
        });

        // Orphaned nodes (no incoming and not a start node)
        const startNode = nodes.find(n => incomingCount.get(n.id) === 0) || nodes[0];
        nodes.forEach(node => {
            if (node.id !== startNode.id && incomingCount.get(node.id) === 0) {
                errors.push({
                    code: 'ORPHAN_NODE',
                    message: `Node ${node.id} is orphaned (no incoming edges).`,
                    nodeId: node.id
                });
            }
        });

        // Reachability from start
        const adjacency = new Map(nodes.map(n => [n.id, []]));
        edges.forEach(edge => {
            if (adjacency.has(edge.source)) {
                adjacency.get(edge.source).push(edge.target);
            }
        });

        const visited = new Set();
        const stack = [startNode.id];
        while (stack.length) {
            const current = stack.pop();
            if (visited.has(current)) continue;
            visited.add(current);
            (adjacency.get(current) || []).forEach(next => stack.push(next));
        }

        nodes.forEach(node => {
            if (!visited.has(node.id)) {
                errors.push({
                    code: 'UNREACHABLE_NODE',
                    message: `Node ${node.id} is unreachable from the start node.`,
                    nodeId: node.id
                });
            }
        });

        // End state reachability
        const endNodes = nodes.filter(n => n.type === 'end');
        if (endNodes.length === 0) {
            errors.push({ code: 'NO_END', message: 'Workflow has no end node.' });
        } else {
            const reachableEnd = endNodes.some(n => visited.has(n.id));
            if (!reachableEnd) {
                errors.push({
                    code: 'UNREACHABLE_END',
                    message: 'No reachable end node from the start.'
                });
            }
        }

        // Cycle detection (DFS)
        const cycleVisited = new Set();
        const inStack = new Set();
        const hasCycle = (nodeId) => {
            if (inStack.has(nodeId)) return true;
            if (cycleVisited.has(nodeId)) return false;

            cycleVisited.add(nodeId);
            inStack.add(nodeId);

            for (const next of adjacency.get(nodeId) || []) {
                if (hasCycle(next)) return true;
            }

            inStack.delete(nodeId);
            return false;
        };

        let cycleFound = false;
        for (const node of nodes) {
            if (hasCycle(node.id)) {
                cycleFound = true;
                break;
            }
        }

        if (cycleFound) {
            errors.push({
                code: 'CYCLE_DETECTED',
                message: 'Workflow contains a circular path. Add a break or termination.'
            });
        }

        return errors;
    }

    /**
     * Process industry-specific service request
     */
    async processIndustryService(industry, serviceType, requestData, callSid) {
        logger.info(`Processing ${industry} ${serviceType} request for call ${callSid}`);

        // Simulate industry processing
        return {
            success: true,
            message: `${serviceType} processed successfully for ${industry}`,
            data: {
                reference: `REF-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
                timestamp: new Date()
            }
        };
    }
}

export default new IVRWorkflowEngine();

