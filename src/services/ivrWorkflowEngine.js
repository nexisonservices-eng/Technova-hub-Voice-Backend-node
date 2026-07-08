﻿import Workflow from '../models/Workflow.js';
import ExecutionLog from '../models/ExecutionLog.js';
import logger from '../utils/logger.js';
import twilio from 'twilio';
import EventEmitter from 'events';
import ivrExecutionEngine from './ivrExecutionEngine.js';
import leadService from './leadService.js';
import appointmentBookingService from './appointmentBookingService.js';
import { emitIVRWorkflowUpdate, emitIVRWorkflowError, emitIVRWorkflowStats } from '../sockets/unifiedSocket.js';
import { deleteFromCloudinary } from '../utils/cloudinaryUtils.js';
import { deleteVoiceAudioAssets } from '../utils/voiceAssetCleanup.js';


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

    _normalizeLeadIntent(rawIntent = '') {
        const normalized = String(rawIntent || '').trim().toLowerCase();
        if (['booking', 'inquiry', 'support', 'other'].includes(normalized)) return normalized;
        return 'other';
    }

    _buildLeadPayloadFromExecution(state = {}, log = null, reason = 'normal') {
        const vars = (state && state.variables && typeof state.variables === 'object') ? state.variables : {};
        const userInputs = Array.isArray(log?.userInputs) ? log.userInputs : [];
        const lastInputs = userInputs.slice(-5).map((entry) => String(entry?.input || '').trim()).filter(Boolean);
        const generatedNotes = lastInputs.length
            ? `IVR inputs: ${lastInputs.join(', ')}`
            : '';

        const leadStatus = reason === 'error' || reason === 'timeout'
            ? 'IN_PROGRESS'
            : 'PENDING_AGENT';

        const recordingUrl = log?.recordingUrl || vars?.recordingUrl || vars?.voicemailUrl || '';
        const recordingSid = vars?.recordingSid || vars?.voicemailSid || '';
        const recordingDuration = Number(vars?.recordingDuration || vars?.voicemailDuration || 0);
        const executionDurationMs = Number(
            Number.isFinite(Number(log?.duration))
                ? log.duration
                : (state?.startTime ? Date.now() - state.startTime : 0)
        );
        const durationSeconds = Number.isFinite(executionDurationMs)
            ? Math.max(0, Math.round(executionDurationMs / 1000))
            : 0;

        const leadData = {
            user: state?.userId || log?.userId || null,
            callSid: state?.callSid || log?.callSid || '',
            workflowId: state?.workflowId || log?.workflowId || null,
            workflowName: state?.workflowName || log?.workflowName || '',
            duration: durationSeconds,
            caller: {
                phoneNumber: state?.callerNumber || log?.callerNumber || '',
                name: String(vars?.callerName || vars?.name || '').trim()
            },
            intent: this._normalizeLeadIntent(vars?.intent || vars?.customerIntent || ''),
            status: leadStatus,
            bookingDetails: {
                notes: String(vars?.notes || vars?.customerNotes || generatedNotes || '').trim(),
                preferences: vars?.preferences && typeof vars.preferences === 'object' ? vars.preferences : undefined
            },
            aiAnalysis: {
                transcription: String(vars?.transcription || '').trim(),
                summary: String(vars?.summary || '').trim(),
                sentiment: String(vars?.sentiment || '').trim(),
                confidenceScore: Number(vars?.confidenceScore || 0) || undefined
            }
        };

        if (recordingUrl) {
            leadData.audioRecordings = [{
                type: 'confirmation',
                url: recordingUrl,
                publicId: String(recordingSid || '').trim() || undefined,
                duration: Number.isFinite(recordingDuration) ? recordingDuration : undefined,
                createdAt: new Date()
            }];
        }

        return leadData;
    }

    async _upsertLeadFromExecution(state = {}, log = null, reason = 'normal') {
        try {
            const leadData = this._buildLeadPayloadFromExecution(state, log, reason);
            if (!leadData.user || !leadData.callSid || !leadData?.caller?.phoneNumber) {
                return;
            }
            await leadService.upsertLeadByCallSid(leadData);
        } catch (error) {
            logger.error(`Failed to upsert lead for call ${state?.callSid || log?.callSid || 'unknown'}:`, error);
        }
    }

    extractCloudinaryPublicId(audioUrl) {
        if (!audioUrl || typeof audioUrl !== 'string') return null;
        const match = audioUrl.match(/\/video\/upload\/(?:v\d+\/)?([^?]+?)(?:\.[a-zA-Z0-9]+)(?:\?|$)/);
        return match ? match[1] : null;
    }

    normalizeCloudinaryAssetId(candidate) {
        if (!candidate || typeof candidate !== 'string') return null;
        const trimmed = candidate.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            return this.extractCloudinaryPublicId(trimmed);
        }
        return trimmed;
    }

    normalizeNodeType(type) {
        const t = String(type || '').trim().toLowerCase();
        if (t === 'greeting') return 'greeting';
        if (t === 'audio') return 'audio';
        if (t === 'input') return 'input';
        if (t === 'conditional') return 'conditional';
        if (t === 'transfer') return 'transfer';
        if (t === 'voicemail') return 'voicemail';
        if (t === 'end') return 'end';
        if ([
            'availability_check',
            'slot_offer',
            'booking_create',
            'booking_confirm',
            'whatsapp_notify',
            'handoff'
        ].includes(t)) return t;
        return t || 'audio';
    }

    sanitizeNodeData(nodeType, data = {}) {
        const source = (data && typeof data === 'object') ? data : {};
        const commonKeys = [
            'promptKey', 'mode', 'messageText', 'text', 'voice', 'language',
            'audioUrl', 'audioPublicId', 'audio_public_id', 'audioAssetId', 'afterPlayback', 'maxRetries', 'max_retries',
            'timeoutSeconds', 'timeout', 'fallbackAudioNodeId'
        ];
        const keysByType = {
            audio: ['promptKey', 'mode', 'messageText', 'text', 'voice', 'language', 'audioUrl', 'audioPublicId', 'audio_public_id', 'audioAssetId', 'afterPlayback', 'maxRetries', 'max_retries', 'timeoutSeconds', 'timeout', 'fallbackAudioNodeId'],
            greeting: ['promptKey', 'mode', 'messageText', 'text', 'voice', 'language', 'audioUrl', 'audioPublicId', 'audio_public_id', 'audioAssetId', 'afterPlayback', 'maxRetries', 'max_retries', 'timeoutSeconds', 'timeout', 'fallbackAudioNodeId'],
            input: [
                ...commonKeys,
                'digit', 'label', 'action', 'destination', 'numDigits', 'num_digits',
                'queueName', 'queue_name', 'workflowSid', 'workflow_sid',
                'callerId', 'caller_id', 'transferTimeout', 'transfer_timeout',
                'maxLength', 'max_length', 'transcribe',
                'promptAudioNodeId', 'prompt_audio_node_id',
                'invalidAudioNodeId', 'invalid_audio_node_id',
                'timeoutAudioNodeId', 'timeout_audio_node_id',
                'maxAttempts', 'max_attempts', 'invalidInputMessage'
            ],
            conditional: [
                ...commonKeys,
                'condition', 'truePath', 'falsePath', 'true_path', 'false_path',
                'variable', 'operator', 'value',
                'businessStartHour', 'business_start_hour',
                'businessEndHour', 'business_end_hour',
                'businessTimezone', 'business_timezone',
                'businessDays', 'business_days',
                'callerNumberVariable', 'caller_number_variable',
                'unknownCallerValues', 'unknown_caller_values',
                'premiumFlagVariable', 'premium_flag_variable',
                'premiumTierVariable', 'premium_tier_variable',
                'premiumSegmentVariable', 'premium_segment_variable',
                'premiumTiers', 'premium_tiers'
            ],
            transfer: [...commonKeys, 'destination', 'department', 'label', 'announceText', 'announce_text', 'timeout', 'transferNumber'],
            voicemail: [
                ...commonKeys,
                'mailbox', 'transcribe', 'transcription',
                'greetingAudioNodeId', 'greeting_audio_node_id',
                'maxLength', 'max_length', 'storageRoute',
                'fallbackNodeId', 'fallback_node_id'
            ],
            availability_check: [
                ...commonKeys,
                'promptText', 'prompt_text',
                'timezone', 'numDigits', 'num_digits',
                'timeoutSeconds', 'timeout',
                'maxRetries', 'max_retries',
                'slotDefinitions', 'slot_definitions',
                'slotDefinitionsText', 'slot_definitions_text',
                'slots', 'slotOptions', 'selectionVariable', 'selection_variable',
                'fallbackNodeId', 'fallback_node_id'
            ],
            slot_offer: [
                ...commonKeys,
                'promptText', 'prompt_text',
                'offerText', 'offer_text',
                'yesDigits', 'yes_digits',
                'noDigits', 'no_digits',
                'timeoutSeconds', 'timeout',
                'maxRetries', 'max_retries',
                'fallbackNodeId', 'fallback_node_id',
                'suggestedSlotVariable', 'suggested_slot_variable'
            ],
            booking_create: [
                ...commonKeys,
                'bookingReferencePrefix', 'booking_reference_prefix',
                'tokenPrefix', 'token_prefix',
                'customerNameVariable', 'customer_name_variable',
                'customerPhoneVariable', 'customer_phone_variable',
                'customerEmailVariable', 'customer_email_variable',
                'notesVariable', 'notes_variable',
                'preventDuplicates', 'prevent_duplicates'
            ],
            booking_confirm: [
                ...commonKeys,
                'promptText', 'prompt_text',
                'yesDigits', 'yes_digits',
                'noDigits', 'no_digits',
                'timeoutSeconds', 'timeout',
                'maxRetries', 'max_retries'
            ],
            whatsapp_notify: [
                ...commonKeys,
                'customerRecipient', 'customer_recipient',
                'adminRecipient', 'admin_recipient',
                'customerTemplateName', 'customer_template_name',
                'adminTemplateName', 'admin_template_name',
                'customerMessageText', 'customer_message_text',
                'adminMessageText', 'admin_message_text',
                'customerTemplateLanguage', 'customer_template_language',
                'adminTemplateLanguage', 'admin_template_language'
            ],
            handoff: [
                ...commonKeys,
                'destination', 'callerId', 'caller_id', 'timeout', 'announcementText', 'announcement_text'
            ],
            end: [
                ...commonKeys,
                'reason', 'terminationType',
                'transferNumber', 'transfer_number',
                'voicemailBox', 'voicemail_box',
                'maxLength', 'max_length',
                'transcribe',
                'callerId', 'caller_id',
                'timeout',
                'callbackDelay', 'callback_delay',
                'maxCallbackAttempts', 'max_callback_attempts',
                'sendSurvey', 'send_survey',
                'logCall', 'log_data',
                'sendReceipt', 'send_receipt',
                'contactMethod', 'contact_method'
            ]
        };

        const allowed = new Set(keysByType[nodeType] || commonKeys);
        const sanitized = {};
        Object.keys(source).forEach((key) => {
            if (allowed.has(key)) {
                sanitized[key] = source[key];
            }
        });

        // Normalize action values.
        if (nodeType === 'input' && typeof sanitized.action === 'string') {
            sanitized.action = sanitized.action.trim().toLowerCase();
        }

        // Normalize numeric fields.
        const numericKeys = [
            'maxRetries', 'max_retries', 'timeoutSeconds', 'timeout', 'numDigits', 'num_digits',
            'transferTimeout', 'transfer_timeout',
            'maxAttempts', 'max_attempts', 'maxLength', 'max_length',
            'callbackDelay', 'callback_delay', 'maxCallbackAttempts', 'max_callback_attempts',
            'businessStartHour', 'business_start_hour', 'businessEndHour', 'business_end_hour'
        ];
        numericKeys.forEach((key) => {
            if (sanitized[key] !== undefined) {
                const n = Number(sanitized[key]);
                if (Number.isFinite(n)) {
                    sanitized[key] = n;
                }
            }
        });

        if (nodeType === 'availability_check' && sanitized.slotDefinitions === undefined) {
            const rawSlots =
                sanitized.slot_definitions ??
                sanitized.slotDefinitionsText ??
                sanitized.slot_definitions_text ??
                sanitized.slots ??
                sanitized.slotOptions;
            if (rawSlots !== undefined) {
                if (Array.isArray(rawSlots)) {
                    sanitized.slotDefinitions = rawSlots;
                } else if (typeof rawSlots === 'string') {
                    try {
                        const parsed = JSON.parse(rawSlots);
                        if (Array.isArray(parsed)) {
                            sanitized.slotDefinitions = parsed;
                        }
                    } catch {
                        sanitized.slotDefinitions = [];
                    }
                }
            }
        }

        return sanitized;
    }

    sanitizeWorkflowPayload(workflowData = {}) {
        const nodes = Array.isArray(workflowData.nodes) ? workflowData.nodes : [];
        const edges = Array.isArray(workflowData.edges) ? workflowData.edges : [];

        const sanitizedNodes = nodes
            .filter((node) => node && typeof node === 'object')
            .map((node, index) => {
                const id = String(node.id || '').trim() || `node_${Date.now()}_${index}`;
                const type = this.normalizeNodeType(node.type);
                const position = {
                    x: Number(node?.position?.x),
                    y: Number(node?.position?.y)
                };
                const safePosition = {
                    x: Number.isFinite(position.x) ? position.x : 0,
                    y: Number.isFinite(position.y) ? position.y : 0
                };
                return {
                    id,
                    type,
                    position: safePosition,
                    data: this.sanitizeNodeData(type, node.data || {})
                };
            });

        const validNodeIds = new Set(sanitizedNodes.map((node) => node.id));
        const seenEdgeKeys = new Set();
        const sanitizedEdges = edges
            .filter((edge) => edge && typeof edge === 'object')
            .map((edge, index) => {
                const source = String(edge.source || '').trim();
                const target = String(edge.target || '').trim();
                const sourceHandle = edge.sourceHandle == null ? null : String(edge.sourceHandle);
                const targetHandle = edge.targetHandle == null ? null : String(edge.targetHandle);
                const id = String(edge.id || '').trim() || `edge_${Date.now()}_${index}`;
                return { id, source, target, sourceHandle, targetHandle };
            })
            .filter((edge) => validNodeIds.has(edge.source) && validNodeIds.has(edge.target))
            .filter((edge) => {
                const key = `${edge.source}|${edge.target}|${edge.sourceHandle || ''}|${edge.targetHandle || ''}`;
                if (seenEdgeKeys.has(key)) return false;
                seenEdgeKeys.add(key);
                return true;
            });

        return {
            ...workflowData,
            nodes: sanitizedNodes,
            edges: sanitizedEdges
        };
    }

    normalizeEdgeHandle(value) {
        if (value === undefined || value === null || value === '') return null;
        return String(value);
    }

    isExactDuplicateEdge(existingEdge = {}, candidateEdge = {}, ignoreEdgeId = null) {
        if (!existingEdge || !candidateEdge) return false;
        if (ignoreEdgeId && String(existingEdge.id) === String(ignoreEdgeId)) return false;
        return (
            String(existingEdge.source || '') === String(candidateEdge.source || '') &&
            String(existingEdge.target || '') === String(candidateEdge.target || '') &&
            this.normalizeEdgeHandle(existingEdge.sourceHandle) === this.normalizeEdgeHandle(candidateEdge.sourceHandle) &&
            this.normalizeEdgeHandle(existingEdge.targetHandle) === this.normalizeEdgeHandle(candidateEdge.targetHandle)
        );
    }

    /**
     * Start a new workflow execution
     */
    async startExecution(workflowId, callSid, callerNumber, destinationNumber, userId = null) {
        try {
            const existingState = this.activeExecutions.get(callSid);
            if (existingState && String(existingState.workflowId) === String(workflowId)) {
                logger.info(`Reusing active execution for call ${callSid} and workflow ${workflowId}`);
                return await ExecutionLog.findById(existingState.executionLogId);
            }

            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            // Create execution log in database
            const executionLog = new ExecutionLog({
                callSid,
                userId: workflow.createdBy || userId,
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
                workflowName: workflow.promptKey,
                userId: workflow.createdBy || userId || null,
                executionLogId: executionLog._id,
                callerNumber,
                destinationNumber,
                startTime: Date.now(),
                currentNodeId: null,
                visitedNodes: [],
                variables: {
                    callerNumber,
                    destinationNumber
                },
                nodeAttempts: {},
                lastInputReasonByNode: {},
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
                currentNodeId: null,
                currentNodeType: null,
                currentNodeLabel: null,
                visitedNodes: [],
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
            currentNodeId: nodeId,
            currentNodeType: nodeType,
            currentNodeLabel: nodeType,
            visitedNodes: state.visitedNodes.map((visit) => ({
                nodeId: visit.nodeId,
                nodeType: visit.nodeType,
                timestamp: visit.timestamp,
                userInput: visit.userInput
            })),
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
        const builtInVariables = {
            callerNumber: state.callerNumber || '',
            destinationNumber: state.destinationNumber || '',
            callSid: state.callSid || ''
        };
        for (const [key, value] of Object.entries(builtInVariables)) {
            const pattern = new RegExp(`\\$\\{${key}\\}|\\$${key}\\b`, 'g');
            result = result.replace(pattern, value);
        }
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

            await this._upsertLeadFromExecution(state, log, reason);

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
                currentNodeId: state.currentNodeId,
                currentNodeType: state.visitedNodes[state.visitedNodes.length - 1]?.nodeType || null,
                currentNodeLabel: state.visitedNodes[state.visitedNodes.length - 1]?.nodeType || null,
                visitedNodes: state.visitedNodes.map((visit) => ({
                    nodeId: visit.nodeId,
                    nodeType: visit.nodeType,
                    timestamp: visit.timestamp,
                    userInput: visit.userInput
                })),
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
            const nodeForExecution = {
                ...node,
                data: { ...(node.data || {}) }
            };

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
                    context.callerNumber = state.callerNumber;
                    context.nodeAttempts = state.nodeAttempts || {};
                    context.lastInputReasonByNode = state.lastInputReasonByNode || {};
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
            if (nodeForExecution.data && nodeForExecution.data.text && callSid) {
                // Clone data to avoid mutating database object reference in memory
                nodeForExecution.data = {
                    ...nodeForExecution.data,
                    text: this.replaceVariables(callSid, nodeForExecution.data.text)
                };
            }
            if (nodeForExecution.data && callSid) {
                const variableTextKeys = [
                    'messageText',
                    'promptText',
                    'offerText',
                    'customerMessageText',
                    'customer_message_text',
                    'adminMessageText',
                    'admin_message_text',
                    'successText',
                    'announcementText'
                ];
                const nextData = { ...nodeForExecution.data };
                let changed = false;
                for (const key of variableTextKeys) {
                    if (typeof nextData[key] === 'string' && nextData[key]) {
                        nextData[key] = this.replaceVariables(callSid, nextData[key]);
                        changed = true;
                    }
                }
                if (changed) {
                    nodeForExecution.data = nextData;
                }
            }

            // Delegate to Execution Engine
            logger.info(`Delegating execution for node ${nodeForExecution.type} (${nodeId})`);
            const workflowConfig = {
                nodes: workflow?.nodes || [],
                edges: workflow?.edges || [],
                settings: workflow?.config || {},
                createdBy: workflow?.createdBy || null,
                _id: workflow._id,
                workflowId: workflow._id
            };
            return await ivrExecutionEngine.executeNode(nodeForExecution, context, workflowConfig, callSid);

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
            const destinationNodeId = String(currentNode?.data?.destination || '').trim();
            const hasDestinationNode = Boolean(
                destinationNodeId && (workflow.nodes || []).some((n) => n.id === destinationNodeId)
            );

            // Record user input
            if (callSid) {
                const state = this.getExecutionState(callSid);
                if (state) {
                    state.nodeAttempts = state.nodeAttempts || {};
                    state.nodeAttempts[currentNodeId] = (state.nodeAttempts[currentNodeId] || 0) + 1;
                    state.variables = state.variables || {};
                    state.variables.lastInputValue = userInput;
                    state.variables.lastInputNodeId = currentNodeId;
                    state.variables[`inputValues:${currentNodeId}`] = userInput;
                    const log = await ExecutionLog.findById(state.executionLogId);
                    if (log) {
                        await log.recordUserInput(currentNodeId, userInput);
                    }
                }
            }

            const settings = workflow.config || {};
            const maxRetries =
                currentNode?.data?.maxAttempts ||
                currentNode?.data?.max_attempts ||
                currentNode?.data?.maxRetries ||
                currentNode?.data?.max_retries ||
                settings.maxAttempts ||
                settings.maxRetries ||
                3;
            const attemptCount = this.getExecutionState(callSid)?.nodeAttempts?.[currentNodeId] || 0;
            const endNodeId = (workflow.nodes || []).find((node) => String(node?.type || '').toLowerCase() === 'end')?.id || null;
            const nodeType = String(currentNode?.type || '').toLowerCase();
            const state = this.getExecutionState(callSid);
            const normalizeDtmfValue = (value) => {
                const normalized = String(value ?? '').trim();
                const normalizedLower = normalized.toLowerCase();
                if (['star', 'asterisk'].includes(normalizedLower)) return '*';
                if (['hash', 'pound'].includes(normalizedLower)) return '#';
                return normalized;
            };
            const normalizeHandleValue = (value) => normalizeDtmfValue(value).toLowerCase();
            const normalizedUserInput = normalizeDtmfValue(userInput);
            const normalizedUserInputLower = normalizeHandleValue(userInput);
            const splitDigitSet = (value, fallback = '') => new Set(
                String(String(value ?? '').trim() || fallback)
                    .split(',')
                    .map((v) => normalizeHandleValue(v))
                    .filter(Boolean)
            );
            const markInputReason = (reason) => {
                if (!callSid) return;
                const currentState = this.getExecutionState(callSid);
                if (!currentState) return;
                currentState.lastInputReasonByNode = currentState.lastInputReasonByNode || {};
                currentState.lastInputReasonByNode[currentNodeId] = reason;
            };
            const setBookingVariable = (key, value) => {
                if (!callSid) return;
                const currentState = this.getExecutionState(callSid);
                if (!currentState) return;
                currentState.variables = currentState.variables || {};
                this.setVariable(callSid, key, value);
            };
            const edgeForHandle = (handle) =>
                edges.find((edge) =>
                    edge.source === currentNodeId &&
                    normalizeHandleValue(edge.sourceHandle) === normalizeHandleValue(handle)
                ) || null;
            const edgeForNodeHandle = (nodeId, handle) =>
                (workflow.edges || []).find((edge) =>
                    edge.source === nodeId &&
                    normalizeHandleValue(edge.sourceHandle) === normalizeHandleValue(handle)
                ) || null;
            const redirectForHandles = (handles = []) => {
                for (const handle of handles) {
                    const edge = edgeForHandle(handle);
                    if (edge) return edge.target;
                }
                return null;
            };
            const nodeExists = (nodeId = '') =>
                Boolean(String(nodeId || '').trim() && (workflow.nodes || []).some((node) => node.id === nodeId));
            const resolveInputOptionTarget = (inputNode) => {
                if (!inputNode) return null;
                const inputNodeId = inputNode.id;
                const inputData = inputNode.data || {};
                const inputDigit = normalizeDtmfValue(inputData.digit);
                const digitEdge = inputDigit ? edgeForNodeHandle(inputNodeId, inputDigit) : null;
                if (digitEdge) return digitEdge.target;

                const defaultEdge =
                    edgeForNodeHandle(inputNodeId, 'default') ||
                    edgeForNodeHandle(inputNodeId, 'success') ||
                    edgeForNodeHandle(inputNodeId, 'next');
                if (defaultEdge) return defaultEdge.target;

                const outgoingEdges = (workflow.edges || []).filter((edge) => edge.source === inputNodeId);
                if (outgoingEdges.length === 1) return outgoingEdges[0].target;

                const inputAction = String(inputData.action || '').trim().toLowerCase();
                const inputDestination = String(inputData.destination || '').trim();
                if (nodeExists(inputDestination)) return inputDestination;

                const actionRequiresExecution = ['transfer', 'queue', 'voicemail'].includes(inputAction);
                if (callSid && inputAction && (actionRequiresExecution || inputDestination)) {
                    const currentState = this.getExecutionState(callSid);
                    if (currentState) {
                        currentState.variables = currentState.variables || {};
                        currentState.variables[`inputAction:${inputNodeId}`] = {
                            action: inputAction,
                            destination: inputDestination
                        };
                    }
                    return inputNodeId;
                }

                return null;
            };
            const resolveAudioFanOutTarget = () => {
                if (!['audio', 'greeting'].includes(nodeType)) return null;

                const directEdge = edges.find((edge) =>
                    normalizeHandleValue(edge.sourceHandle) === normalizedUserInputLower ||
                    normalizeHandleValue(edge.data?.digit) === normalizedUserInputLower
                );
                if (directEdge) {
                    const targetNode = (workflow.nodes || []).find((node) => node.id === directEdge.target);
                    if (String(targetNode?.type || '').toLowerCase() === 'input') {
                        return resolveInputOptionTarget(targetNode) || targetNode.id;
                    }
                    return directEdge.target;
                }

                for (const edge of edges) {
                    const targetNode = (workflow.nodes || []).find((node) => node.id === edge.target);
                    if (String(targetNode?.type || '').toLowerCase() !== 'input') continue;
                    const targetDigit = normalizeHandleValue(targetNode?.data?.digit);
                    if (!targetDigit || targetDigit !== normalizedUserInputLower) continue;

                    return resolveInputOptionTarget(targetNode);
                }

                return null;
            };

            if (callSid && state && currentNode && ['availability_check', 'slot_offer', 'booking_confirm', 'booking_create', 'whatsapp_notify', 'handoff'].includes(nodeType)) {
                state.variables = state.variables || {};
            }

            try {
            if (nodeType === 'availability_check') {
                const slotSnapshot = await appointmentBookingService.getSlotSnapshot(currentNode, workflow, state || {});
                const selectedSlot = appointmentBookingService.resolveSlotFromInput(currentNode, workflow, state || {}, userInput);
                const selectionVariable = String(
                    currentNode?.data?.selectionVariable ||
                    currentNode?.data?.selection_variable ||
                    'booking.selectedSlotKey'
                ).trim() || 'booking.selectedSlotKey';
                const yesLike = new Set(['1', 'y', 'yes', 'true', 'confirm', 'confirmed', 'ok', 'okay']);
                const noLike = new Set(['2', 'n', 'no', 'false', 'cancel', 'cancelled', 'canceled']);

                const routeToFallback = (preferredHandles = ['full', 'fallback', 'no_match', 'default']) =>
                    redirectForHandles(preferredHandles) || endNodeId;
                const persistSelectedSlot = (slot = null) => {
                    if (!slot) return;
                    const slotData = {
                        key: slot.slotKey || slot.key || '',
                        label: slot.slotLabel || slot.label || '',
                        startTime: slot.slotStart || slot.startTime || '',
                        endTime: slot.slotEnd || slot.endTime || '',
                        capacity: slot.capacity ?? 1,
                        bookedCount: slot.bookedCount ?? slot.booked_count ?? 0,
                        digit: slot?.metadata?.digit || slot.digit || '',
                        order: slot?.metadata?.order ?? slot.order ?? 0,
                        active: slot.status !== 'disabled',
                        slotDate: slot.slotDate || appointmentBookingService.getDateKey(currentNode, workflow, state || {}),
                        metadata: slot?.metadata || {}
                    };
                    setBookingVariable('booking.selectedSlotData', slotData);
                };

                if (slotSnapshot.length === 0) {
                    markInputReason('full');
                    return routeToFallback();
                }

                if (!selectedSlot) {
                    if (yesLike.has(normalizedUserInputLower)) {
                        const firstAvailable = slotSnapshot.find((slot) => slot?.isAvailable) || null;
                        if (firstAvailable) {
                            setBookingVariable(selectionVariable, firstAvailable.slotKey);
                            setBookingVariable('booking.selectedSlotKey', firstAvailable.slotKey);
                            setBookingVariable('booking.selectedSlotLabel', firstAvailable.slotLabel);
                            setBookingVariable('booking.selectedSlotDate', firstAvailable.slotDate || appointmentBookingService.getDateKey(currentNode, workflow, state || {}));
                            setBookingVariable('booking.selectedSlotCapacity', firstAvailable?.capacity ?? 1);
                            setBookingVariable('booking.selectedSlotBookedCount', firstAvailable?.bookedCount ?? 0);
                            setBookingVariable('booking.available', true);
                            persistSelectedSlot(firstAvailable);
                            const nextAvailableSlot = appointmentBookingService.findNextAvailableSlot(slotSnapshot);
                            if (nextAvailableSlot) {
                                setBookingVariable('booking.nextAvailableSlotKey', nextAvailableSlot.slotKey);
                                setBookingVariable('booking.nextAvailableSlotLabel', nextAvailableSlot.slotLabel);
                                setBookingVariable('booking.nextAvailableSlotData', {
                                    key: nextAvailableSlot.slotKey,
                                    label: nextAvailableSlot.slotLabel,
                                    startTime: nextAvailableSlot.slotStart || '',
                                    endTime: nextAvailableSlot.slotEnd || '',
                                    capacity: nextAvailableSlot.capacity ?? 1,
                                    bookedCount: nextAvailableSlot.bookedCount ?? 0,
                                    digit: nextAvailableSlot?.metadata?.digit || '',
                                    order: nextAvailableSlot?.metadata?.order ?? 0,
                                    active: nextAvailableSlot.status !== 'disabled',
                                    slotDate: nextAvailableSlot.slotDate || appointmentBookingService.getDateKey(currentNode, workflow, state || {}),
                                    metadata: nextAvailableSlot?.metadata || {}
                                });
                            }
                            markInputReason('matched');
                            return redirectForHandles(['available', 'success', 'yes', 'true']) || edgeForHandle('default')?.target || endNodeId;
                        }
                    }

                    if (noLike.has(normalizedUserInputLower)) {
                        markInputReason('full');
                        return routeToFallback(['full', 'fallback', 'no_match', 'default']);
                    }

                    markInputReason('invalid');
                    if (attemptCount < maxRetries) return currentNodeId;
                    return routeToFallback(['invalid', 'full', 'fallback', 'no_match', 'default']);
                }

                const matchedSlot = slotSnapshot.find((slot) => String(slot.slotKey) === String(selectedSlot.key));
                const nextAvailableSlot = appointmentBookingService.findNextAvailableSlot(slotSnapshot);
                setBookingVariable(selectionVariable, selectedSlot.key);
                setBookingVariable('booking.selectedSlotKey', selectedSlot.key);
                setBookingVariable('booking.selectedSlotLabel', matchedSlot?.slotLabel || selectedSlot.label);
                setBookingVariable('booking.selectedSlotDate', matchedSlot?.slotDate || appointmentBookingService.getDateKey(currentNode, workflow, state || {}));
                setBookingVariable('booking.selectedSlotCapacity', matchedSlot?.capacity ?? selectedSlot.capacity ?? 1);
                setBookingVariable('booking.selectedSlotBookedCount', matchedSlot?.bookedCount ?? 0);
                setBookingVariable('booking.available', Boolean(matchedSlot?.isAvailable));
                persistSelectedSlot(matchedSlot || selectedSlot);
                if (nextAvailableSlot) {
                    setBookingVariable('booking.nextAvailableSlotKey', nextAvailableSlot.slotKey);
                    setBookingVariable('booking.nextAvailableSlotLabel', nextAvailableSlot.slotLabel);
                    setBookingVariable('booking.nextAvailableSlotData', {
                        key: nextAvailableSlot.slotKey,
                        label: nextAvailableSlot.slotLabel,
                        startTime: nextAvailableSlot.slotStart || '',
                        endTime: nextAvailableSlot.slotEnd || '',
                        capacity: nextAvailableSlot.capacity ?? 1,
                        bookedCount: nextAvailableSlot.bookedCount ?? 0,
                        digit: nextAvailableSlot?.metadata?.digit || '',
                        order: nextAvailableSlot?.metadata?.order ?? 0,
                        active: nextAvailableSlot.status !== 'disabled',
                        slotDate: nextAvailableSlot.slotDate || appointmentBookingService.getDateKey(currentNode, workflow, state || {}),
                        metadata: nextAvailableSlot?.metadata || {}
                    });
                }

                if (matchedSlot?.isAvailable) {
                    markInputReason('matched');
                    const nextNode = redirectForHandles(['available', 'success', 'yes', 'true']) || edgeForHandle('default')?.target || endNodeId;
                    return nextNode;
                }

                markInputReason('full');
                return routeToFallback(['full', 'retry', 'no', 'false']);
            }

            if (nodeType === 'slot_offer') {
                const yesDigits = splitDigitSet(currentNode?.data?.yesDigits || currentNode?.data?.yes_digits, '1');
                const noDigits = splitDigitSet(currentNode?.data?.noDigits || currentNode?.data?.no_digits, '2');
                const selectedSlotKey = String(state?.variables?.['booking.nextAvailableSlotKey'] || '').trim();
                if (yesDigits.has(normalizedUserInputLower)) {
                    if (selectedSlotKey) {
                        setBookingVariable('booking.selectedSlotKey', selectedSlotKey);
                        setBookingVariable('booking.selectedSlotLabel', state?.variables?.['booking.nextAvailableSlotLabel'] || selectedSlotKey);
                        setBookingVariable('booking.available', true);
                        const nextAvailableSlotData = state?.variables?.['booking.nextAvailableSlotData'];
                        if (nextAvailableSlotData) {
                            setBookingVariable('booking.selectedSlotData', {
                                ...nextAvailableSlotData,
                                key: nextAvailableSlotData.key || selectedSlotKey,
                                label: nextAvailableSlotData.label || state?.variables?.['booking.nextAvailableSlotLabel'] || selectedSlotKey
                            });
                        }
                    }
                    markInputReason('matched');
                    return redirectForHandles(['yes', 'true', 'accept', 'success']) || edgeForHandle('yes')?.target || endNodeId;
                }
                if (noDigits.has(normalizedUserInputLower)) {
                    markInputReason('matched');
                    return redirectForHandles(['no', 'false', 'decline', 'fallback']) || edgeForHandle('no')?.target || endNodeId;
                }
                markInputReason('invalid');
                if (attemptCount < maxRetries) return currentNodeId;
                return redirectForHandles(['retry', 'fallback', 'no_match', 'default']) || endNodeId;
            }

            if (nodeType === 'booking_confirm') {
                const yesDigits = splitDigitSet(currentNode?.data?.yesDigits || currentNode?.data?.yes_digits, '1');
                const noDigits = splitDigitSet(currentNode?.data?.noDigits || currentNode?.data?.no_digits, '2');
                if (yesDigits.has(normalizedUserInputLower)) {
                    setBookingVariable('booking.confirmed', true);
                    markInputReason('matched');
                    return redirectForHandles(['yes', 'true', 'confirm', 'success']) || edgeForHandle('yes')?.target || endNodeId;
                }
                if (noDigits.has(normalizedUserInputLower)) {
                    setBookingVariable('booking.confirmed', false);
                    markInputReason('matched');
                    return redirectForHandles(['no', 'false', 'reject', 'fallback']) || edgeForHandle('no')?.target || endNodeId;
                }
                markInputReason('invalid');
                if (attemptCount < maxRetries) return currentNodeId;
                return redirectForHandles(['timeout', 'fallback', 'default']) || endNodeId;
            }

            if (nodeType === 'booking_create') {
                setBookingVariable('booking.lastAction', 'create');
                return redirectForHandles(['success', 'default', 'next']) || edgeForHandle('success')?.target || endNodeId;
            }

            if (nodeType === 'whatsapp_notify') {
                setBookingVariable('booking.lastAction', 'notify');
                return redirectForHandles(['success', 'default', 'next']) || edgeForHandle('success')?.target || endNodeId;
            }
            } catch (bookingFlowError) {
                logger.error(`Booking flow input handling failed at node ${currentNodeId}:`, bookingFlowError);
                markInputReason('error');
                if (attemptCount < maxRetries) return currentNodeId;
                return redirectForHandles(['failure', 'error', 'fallback', 'no_match', 'default']) || endNodeId;
            }

            // Timeout (no digits)
            if (!normalizedUserInput) {
                markInputReason('timeout');
                // Retry-first behavior: timeout should not branch immediately.
                if (attemptCount < maxRetries) return currentNodeId;
                const fallback = redirectForHandles(['no_match', 'default', 'fallback', 'timeout']);
                if (fallback) return fallback;
                return endNodeId;
            }

            const audioFanOutTarget = resolveAudioFanOutTarget();
            if (audioFanOutTarget) {
                markInputReason('matched');
                return audioFanOutTarget;
            }

            // Find edge matching userInput (digit)
            const edge = edges.find((e) =>
                normalizeHandleValue(e.sourceHandle) === normalizedUserInputLower ||
                normalizeHandleValue(e.data?.digit) === normalizedUserInputLower
            );
            if (edge) {
                markInputReason('matched');
                return edge.target;
            }

            // Support legacy/compact input-node destination routing when no explicit edge is present.
            // This keeps "action + destination(nodeId)" configurations functional.
            const inputAction = String(currentNode?.data?.action || '').trim().toLowerCase();
            const inputDestination = String(currentNode?.data?.destination || '').trim();
            const configuredDigit = normalizeDtmfValue(currentNode?.data?.digit);
            const digitMatches = !configuredDigit || normalizedUserInput === configuredDigit;
            if (hasDestinationNode && digitMatches) {
                markInputReason('matched');
                return destinationNodeId;
            }

            // Support action-based execution directly on input node when graph edges are not defined.
            const actionRequiresDestination = ['transfer', 'submenu'].includes(inputAction);
            if (callSid && digitMatches && inputAction && (!actionRequiresDestination || inputDestination)) {
                const state = this.getExecutionState(callSid);
                if (state) {
                    state.variables = state.variables || {};
                    state.variables[`inputAction:${currentNodeId}`] = {
                        action: inputAction,
                        destination: inputDestination
                    };
                }
                return currentNodeId;
            }

            // Invalid input
            markInputReason('invalid');
            if (attemptCount < maxRetries) return currentNodeId;
            const fallbackEdge = redirectForHandles(['no_match', 'default', 'fallback', 'invalid']);
            if (fallbackEdge) return fallbackEdge;
            return endNodeId;
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

            const sanitizedPayload = this.sanitizeWorkflowPayload(workflowData || {});

            // Get existing nodes to compare text changes
            const existingNodes = workflow.nodes || [];
            const existingNodeMap = new Map(existingNodes.map(n => [n.id, n]));

            // Track nodes that need old audio deleted
            const nodesToDeleteAudio = [];

            // Update configuration fields
            if (sanitizedPayload.nodes) {
                const incomingNodes = sanitizedPayload.nodes || [];
                const incomingNodeIds = new Set(incomingNodes.map((node) => node.id));
                const incomingAudioIds = new Set(
                    incomingNodes
                        .map((node) => this.normalizeCloudinaryAssetId(node?.data?.audioPublicId || node?.data?.audioAssetId || node?.audioAssetId))
                        .filter(Boolean)
                );

                // Track audio from nodes removed in this save.
                for (const existingNode of existingNodes) {
                    if (!incomingNodeIds.has(existingNode.id)) {
                        const oldAudioUrl = existingNode.data?.audioUrl || existingNode.audioUrl;
                        const oldAudioAssetId = existingNode.data?.audioPublicId || existingNode.data?.audioAssetId || existingNode.audioAssetId;
                        if (oldAudioUrl || oldAudioAssetId) {
                            nodesToDeleteAudio.push({
                                nodeId: existingNode.id,
                                audioUrl: oldAudioUrl,
                                audioAssetId: oldAudioAssetId
                            });
                        }
                    }
                }

                // Check for text changes and clear audio URLs for changed nodes
                sanitizedPayload.nodes = incomingNodes.map(node => {
                    const existingNode = existingNodeMap.get(node.id);
                    if (existingNode) {
                        const oldText = existingNode.data?.messageText || existingNode.data?.text || existingNode.data?.message || '';
                        const newText = node.data?.messageText || node.data?.text || node.data?.message || '';

                        // If text changed, clear the audio URL to force regeneration
                        if (oldText !== newText && newText.trim()) {
                            logger.info(`📝 Text changed for node ${node.id}, clearing old audio URL`);

                            // Track old audio for deletion
                            const oldAudioUrl = existingNode.data?.audioUrl || existingNode.audioUrl;
                            const oldAudioAssetId = existingNode.data?.audioPublicId || existingNode.data?.audioAssetId || existingNode.audioAssetId;
                            if (oldAudioUrl || oldAudioAssetId) {
                                nodesToDeleteAudio.push({
                                    nodeId: node.id,
                                    audioUrl: oldAudioUrl,
                                    audioAssetId: oldAudioAssetId
                                });
                            }

                            // Clear audio URL to force regeneration
                            node.data = {
                                ...node.data,
                                audioUrl: null,
                                audioAssetId: null
                            };
                        }
                    }
                    return node;
                });

                workflow.nodes = sanitizedPayload.nodes;

                // If an audio ID still exists on any incoming node, don't delete it.
                for (let i = nodesToDeleteAudio.length - 1; i >= 0; i -= 1) {
                    const candidate = nodesToDeleteAudio[i];
                    const normalizedId = this.normalizeCloudinaryAssetId(candidate.audioAssetId)
                        || this.extractCloudinaryPublicId(candidate.audioUrl);
                    if (normalizedId && incomingAudioIds.has(normalizedId)) {
                        nodesToDeleteAudio.splice(i, 1);
                    }
                }
            }

            // Delete old Cloudinary audio files asynchronously (don't block save)
            if (nodesToDeleteAudio.length > 0) {
                const uniqueDeletes = new Map();
                nodesToDeleteAudio.forEach(({ nodeId, audioUrl, audioAssetId }) => {
                    const publicId = this.normalizeCloudinaryAssetId(audioAssetId) || this.extractCloudinaryPublicId(audioUrl);
                    if (!publicId) return;
                    if (!uniqueDeletes.has(publicId)) {
                        uniqueDeletes.set(publicId, nodeId);
                    }
                });

                logger.info(`🗑️ Deleting ${uniqueDeletes.size} old audio files from Cloudinary`);
                uniqueDeletes.forEach(async (nodeId, publicId) => {
                    try {
                        await deleteFromCloudinary(publicId);
                        logger.info(`✅ Deleted old audio for node ${nodeId}: ${publicId}`);
                    } catch (deleteError) {
                        logger.warn(`⚠️ Failed to delete old audio for node ${nodeId}:`, deleteError.message);
                        // Don't fail the save if deletion fails
                    }
                });
            }

            if (sanitizedPayload.edges) workflow.edges = sanitizedPayload.edges;
            if (sanitizedPayload.settings) {
                workflow.config = {
                    ...workflow.config,
                    ...sanitizedPayload.settings
                };
            }

            // Save workflow (triggers pre-save validation)
            // Default to completed, will be set to pending if TTS is needed
            workflow.ttsStatus = 'completed';

            // Enqueue background TTS job for nodes that need audio
            let ttsJobId = null;

            // Debug logging to trace node processing
            logger.info(`🔍 Checking ${workflow.nodes.length} nodes for audio generation needs`);
            workflow.nodes.forEach((node, idx) => {
                const data = node.data || {};
                const hasText = !!(data.text || data.message || data.prompt || data.messageText);
                const hasAudio = !!data.audioUrl;
                const isSupportedType = ['message', 'menu', 'prompt', 'greeting', 'audio'].includes(node.type);
                logger.info(`🔍 Node ${idx}: id=${node.id}, type=${node.type}, hasText=${hasText}, hasAudio=${hasAudio}, isSupportedType=${isSupportedType}`);
                logger.info(`🔍 Node ${idx} data fields: ${Object.keys(data).join(', ')}`);
            });

            const nodesNeedingAudio = workflow.nodes.filter(node => {
                const nodeTypes = ['message', 'menu', 'prompt', 'greeting', 'audio'];
                const data = node.data || {};
                // Check if node type supports TTS, has text, AND doesn't already have audio
                // This makes the process idempotent - hitting save twice won't regenerate existing audio
                const needsAudio = nodeTypes.includes(node.type) &&
                    (data.text || data.message || data.prompt || data.messageText) &&
                    !data.audioUrl;
                if (needsAudio) {
                    logger.info(`✅ Node ${node.id} needs audio generation`);
                }
                return needsAudio;
            });

            if (nodesNeedingAudio.length > 0) {

                try {
                    const ttsJobQueue = (await import('./ttsJobQueue.js')).default;
                    // ✅ Fire-and-forget background job (Fixes 30s timeout)
                    // The job queue handles processing asynchronously
                    ttsJobId = await ttsJobQueue.addJob(workflowId, nodesNeedingAudio, false);

                    // Set status to pending since job is queued
                    workflow.ttsStatus = 'pending';
                    logger.info(`✅ Queued background TTS job ${ttsJobId} for ${nodesNeedingAudio.length} nodes in workflow ${workflowId}`);
                } catch (queueError) {
                    logger.error(`❌ Failed to queue TTS job for workflow ${workflowId}:`, queueError);
                    workflow.ttsStatus = 'failed';
                    // Don't fail the save, just log the error
                }
            }

            await workflow.save();

            // Return workflow with TTS job info for tracking
            return {
                ...workflow.toObject(),
                ttsJobId,
                nodesNeedingAudio
            };
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

            const existingIds = new Set((workflow.nodes || []).map((n) => n?.id).filter(Boolean));
            let nodeId = node?.id;
            if (!nodeId || existingIds.has(nodeId)) {
                const baseId = nodeId || 'node';
                nodeId = `${baseId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
            }

            const newNode = {
                ...node,
                id: nodeId,
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

            const candidateEdge = {
                source: String(sourceNode || ''),
                target: String(targetNode || ''),
                sourceHandle: this.normalizeEdgeHandle(sourceHandle),
                targetHandle: this.normalizeEdgeHandle(targetHandle)
            };

            const existingEdge = (workflow.edges || []).find((edge) =>
                this.isExactDuplicateEdge(edge, candidateEdge)
            );
            if (existingEdge) {
                return existingEdge;
            }

            const newEdge = {
                id: edgeId || `e-${sourceNode}-${targetNode}-${Date.now()}`,
                ...candidateEdge
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

            const currentEdge = workflow.edges[edgeIndex];
            const nextEdge = {
                ...currentEdge,
                ...updates
            };

            const duplicateEdge = (workflow.edges || []).find((edge) =>
                this.isExactDuplicateEdge(edge, nextEdge, edgeId)
            );
            if (duplicateEdge) {
                return currentEdge;
            }

            workflow.edges[edgeIndex] = {
                ...nextEdge
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

            // Find the node being deleted to get its audio
            const nodeToDelete = workflow.nodes.find(n => n.id === nodeId);

            // Delete Cloudinary audio file if exists
            if (nodeToDelete) {
                // Check all possible locations for audio asset ID
                let audioAssetId = this.normalizeCloudinaryAssetId(
                    nodeToDelete.data?.audioPublicId || nodeToDelete.data?.audioAssetId || nodeToDelete.audioAssetId
                );

                // If we have an audio URL but no asset ID, extract it from the URL
                if (!audioAssetId && (nodeToDelete.data?.audioUrl || nodeToDelete.audioUrl)) {
                    const audioUrl = nodeToDelete.data?.audioUrl || nodeToDelete.audioUrl;
                    const extractedPublicId = this.extractCloudinaryPublicId(audioUrl);
                    if (extractedPublicId) {
                        audioAssetId = extractedPublicId;
                        logger.info(`🔍 Extracted audioAssetId from URL for node ${nodeId}: ${audioAssetId}`);
                    }
                }

                if (audioAssetId) {
                    try {
                        await deleteFromCloudinary(audioAssetId);
                        logger.info(`🗑️ Deleted Cloudinary audio for deleted node ${nodeId}: ${audioAssetId}`);
                    } catch (deleteError) {
                        logger.warn(`⚠️ Failed to delete Cloudinary audio for node ${nodeId}:`, deleteError.message);
                        // Don't fail the delete if Cloudinary deletion fails
                    }
                } else {
                    logger.info(`ℹ️ No audio found to delete for node ${nodeId}`);
                }
            }

            workflow.nodes = workflow.nodes.filter(n => n.id !== nodeId);
            workflow.edges = workflow.edges.filter(e => e.source !== nodeId && e.target !== nodeId);

            await workflow.save();
            logger.info(`✅ Deleted node ${nodeId} from workflow ${workflowId}`);
            return workflow;
        } catch (error) {
            logger.error('Error deleting node:', error);
            throw error;
        }
    }


    /**
     * Delete entire workflow and all associated audio files
     */
    async deleteWorkflow(workflowId) {
        try {
            const workflow = await Workflow.findById(workflowId);
            if (!workflow) throw new Error('Workflow not found');

            logger.info(`🗑️ Deleting workflow ${workflowId} and all associated audio files`);

            const nodesWithAudio = workflow.nodes?.filter(n =>
                n.data?.audioAssetId || n.audioAssetId || n.data?.audioUrl || n.audioUrl
            ) || [];
            const cloudinaryCleanup = await deleteVoiceAudioAssets([workflow], {
                type: 'workflow',
                workflowId: String(workflowId),
                userId: String(workflow.createdBy || '')
            });

            // Delete the workflow from database
            await Workflow.findByIdAndDelete(workflowId);

            logger.info(`✅ Successfully deleted workflow ${workflowId} and all associated audio`);
            return { success: true, deletedNodes: nodesWithAudio.length, cloudinary: cloudinaryCleanup };
        } catch (error) {
            logger.error(`❌ Error deleting workflow ${workflowId}:`, error);
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

        const normalizedNodeIds = nodes.map((n) => (typeof n?.id === 'string' ? n.id.trim() : ''));
        const nodeIds = new Set();
        const duplicateNodeIds = new Set();
        const invalidNodeIds = [];
        normalizedNodeIds.forEach((nodeId, index) => {
            if (!nodeId) {
                invalidNodeIds.push(nodes[index]?.id ?? null);
                return;
            }
            if (nodeIds.has(nodeId)) {
                duplicateNodeIds.add(nodeId);
            }
            nodeIds.add(nodeId);
        });

        if (invalidNodeIds.length > 0) {
            errors.push({
                code: 'INVALID_NODE_ID',
                message: 'One or more nodes are missing a valid ID.'
            });
        }
        if (duplicateNodeIds.size > 0) {
            errors.push({
                code: 'DUPLICATE_NODE_ID',
                message: `Duplicate node IDs found: ${Array.from(duplicateNodeIds).join(', ')}`
            });
        }

        if (errors.some((e) => e.code === 'INVALID_NODE_ID' || e.code === 'DUPLICATE_NODE_ID')) {
            return errors;
        }

        const incomingCount = new Map(nodes.map(n => [n.id, 0]));
        const edgeKeySet = new Set();
        const sourceHandleTracker = new Map();
        const audioNodeIds = new Set(
            nodes
                .filter((n) => ['audio', 'greeting'].includes((n.type || '').toLowerCase()))
                .map((n) => n.id)
        );

        // Broken connections and incoming counts
        edges.forEach(edge => {
            if (!edge?.id || typeof edge.id !== 'string') {
                errors.push({
                    code: 'INVALID_EDGE_ID',
                    message: 'Edge without a valid ID detected.'
                });
                return;
            }

            const edgeKey = `${edge.source}|${edge.target}|${edge.sourceHandle || ''}|${edge.targetHandle || ''}`;
            if (edgeKeySet.has(edgeKey)) {
                errors.push({
                    code: 'DUPLICATE_EDGE',
                    message: `Duplicate edge detected for ${edge.source} -> ${edge.target}.`,
                    edgeId: edge.id
                });
            }
            edgeKeySet.add(edgeKey);

            if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
                errors.push({
                    code: 'BROKEN_EDGE',
                    message: `Edge ${edge.id} references missing node(s).`,
                    edgeId: edge.id
                });
                return;
            }
            incomingCount.set(edge.target, (incomingCount.get(edge.target) || 0) + 1);

            const sourceNode = nodes.find((n) => n.id === edge.source);
            const sourceType = (sourceNode?.type || '').toLowerCase();
            if (['input', 'conditional', 'availability_check', 'slot_offer', 'booking_confirm', 'booking_create', 'whatsapp_notify'].includes(sourceType)) {
                const handle = edge.sourceHandle || '__default__';
                const handleKey = `${edge.source}:${handle}`;
                if (sourceHandleTracker.has(handleKey)) {
                    errors.push({
                        code: 'DUPLICATE_SOURCE_HANDLE',
                        message: `Node ${edge.source} has multiple outgoing edges for handle "${handle}".`,
                        edgeId: edge.id
                    });
                } else {
                    sourceHandleTracker.set(handleKey, edge.id);
                }
            }
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
        const endNodes = nodes.filter(n => String(n?.type || '').toLowerCase() === 'end');
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

        const parsePositiveInt = (value, fallback) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
            return Math.floor(parsed);
        };

        const asNodeId = (value) => (typeof value === 'string' ? value.trim() : '');
        const hasOutgoingEdge = (sourceId, handle = null) =>
            edges.some((edge) => edge.source === sourceId && (handle == null || edge.sourceHandle === handle));

        nodes.forEach((node) => {
            const nodeType = (node.type || '').toLowerCase();
            const data = node.data || {};

            if (nodeType === 'audio' || nodeType === 'greeting') {
                const mode = (data.mode || 'tts').toLowerCase();
                const messageText = (data.messageText || data.text || data.message || '').trim();
                const audioUrl = (data.audioUrl || '').trim();

                if (mode === 'tts' && !messageText) {
                    errors.push({
                        code: 'AUDIO_TEXT_REQUIRED',
                        message: `Audio node ${node.id} is in TTS mode but has no text.`,
                        nodeId: node.id
                    });
                }
                if ((mode === 'upload' || mode === 'file') && !audioUrl) {
                    errors.push({
                        code: 'AUDIO_URL_REQUIRED',
                        message: `Audio node ${node.id} is in file/upload mode but has no audio URL.`,
                        nodeId: node.id
                    });
                }

                const fallbackAudioNodeId = asNodeId(data.fallbackAudioNodeId);
                if (fallbackAudioNodeId && !audioNodeIds.has(fallbackAudioNodeId)) {
                    errors.push({
                        code: 'INVALID_AUDIO_FALLBACK_REF',
                        message: `Audio node ${node.id} fallbackAudioNodeId points to non-audio node: ${fallbackAudioNodeId}.`,
                        nodeId: node.id
                    });
                }
            }

            if (nodeType === 'input') {
                const promptAudioNodeId = asNodeId(data.promptAudioNodeId || data.prompt_audio_node_id);
                const invalidAudioNodeId = asNodeId(data.invalidAudioNodeId || data.invalid_audio_node_id);
                const timeoutAudioNodeId = asNodeId(data.timeoutAudioNodeId || data.timeout_audio_node_id);

                if (!promptAudioNodeId || !audioNodeIds.has(promptAudioNodeId)) {
                    errors.push({
                        code: 'INVALID_PROMPT_AUDIO_REF',
                        message: `Input node ${node.id} must reference a valid prompt audio node.`,
                        nodeId: node.id
                    });
                }
                if (invalidAudioNodeId && !audioNodeIds.has(invalidAudioNodeId)) {
                    errors.push({
                        code: 'INVALID_INPUT_AUDIO_REF',
                        message: `Input node ${node.id} invalidAudioNodeId points to non-audio node: ${invalidAudioNodeId}.`,
                        nodeId: node.id
                    });
                }
                if (timeoutAudioNodeId && !audioNodeIds.has(timeoutAudioNodeId)) {
                    errors.push({
                        code: 'INVALID_TIMEOUT_AUDIO_REF',
                        message: `Input node ${node.id} timeoutAudioNodeId points to non-audio node: ${timeoutAudioNodeId}.`,
                        nodeId: node.id
                    });
                }

                const timeoutSeconds = parsePositiveInt(data.timeoutSeconds ?? data.timeout, 0);
                const maxAttempts = parsePositiveInt(data.maxAttempts ?? data.max_attempts, 0);
                if (timeoutSeconds < 1 || timeoutSeconds > 60) {
                    errors.push({
                        code: 'INVALID_TIMEOUT',
                        message: `Input node ${node.id} timeout must be between 1 and 60 seconds.`,
                        nodeId: node.id
                    });
                }
                if (maxAttempts < 1 || maxAttempts > 10) {
                    errors.push({
                        code: 'INVALID_MAX_ATTEMPTS',
                        message: `Input node ${node.id} maxAttempts must be between 1 and 10.`,
                        nodeId: node.id
                    });
                }

                const digit = (data.digit || '').toString().trim();
                if (digit && !hasOutgoingEdge(node.id, digit)) {
                    errors.push({
                        code: 'MISSING_DIGIT_ROUTE',
                        message: `Input node ${node.id} digit "${digit}" has no matching outgoing edge.`,
                        nodeId: node.id
                    });
                }
            }

            if (nodeType === 'conditional') {
                if (!hasOutgoingEdge(node.id, 'true')) {
                    errors.push({
                        code: 'MISSING_TRUE_BRANCH',
                        message: `Conditional node ${node.id} must have a "true" branch.`,
                        nodeId: node.id
                    });
                }
                if (!hasOutgoingEdge(node.id, 'false')) {
                    errors.push({
                        code: 'MISSING_FALSE_BRANCH',
                        message: `Conditional node ${node.id} must have a "false" branch.`,
                        nodeId: node.id
                    });
                }
            }

            if (nodeType === 'voicemail') {
                const greetingAudioNodeId = asNodeId(data.greetingAudioNodeId || data.greeting_audio_node_id);
                if (greetingAudioNodeId && !audioNodeIds.has(greetingAudioNodeId)) {
                    errors.push({
                        code: 'INVALID_VOICEMAIL_GREETING_REF',
                        message: `Voicemail node ${node.id} greetingAudioNodeId points to non-audio node: ${greetingAudioNodeId}.`,
                        nodeId: node.id
                    });
                }
            }

            if (nodeType === 'availability_check') {
                const slots = Array.isArray(data.slotDefinitions) ? data.slotDefinitions : [];
                if (slots.length === 0) {
                    errors.push({
                        code: 'MISSING_SLOT_DEFINITIONS',
                        message: `Availability Check node ${node.id} requires at least one slot definition.`,
                        nodeId: node.id
                    });
                }
                const promptText = String(data.promptText || data.prompt_text || '').trim();
                if (!promptText) {
                    errors.push({
                        code: 'MISSING_PROMPT_TEXT',
                        message: `Availability Check node ${node.id} requires prompt text.`,
                        nodeId: node.id
                    });
                }
            }

            if (nodeType === 'slot_offer' || nodeType === 'booking_confirm') {
                const promptText = String(data.promptText || data.prompt_text || '').trim();
                if (!promptText) {
                    errors.push({
                        code: 'MISSING_PROMPT_TEXT',
                        message: `${nodeType} node ${node.id} requires prompt text.`,
                        nodeId: node.id
                    });
                }
            }
        });

        return errors;
    }

}

export default new IVRWorkflowEngine();
