import Call from '../models/call.js';
import ExecutionLog from '../models/ExecutionLog.js';
import Workflow from '../models/Workflow.js';
import AppointmentBooking from '../models/AppointmentBooking.js';
import BookingNotificationLog from '../models/BookingNotificationLog.js';
import logger from '../utils/logger.js';
import { parseDateOnlyInTimezone } from '../utils/timezoneDate.js';

const VOICE_TIME_ZONE = 'Asia/Kolkata';
const STALE_RUNNING_EXECUTION_MS = 30 * 60 * 1000;

const WORKFLOW_CAPABILITY_DEFS = [
    { key: 'audio', label: 'Audio', types: ['audio', 'greeting'] },
    { key: 'input', label: 'Input', types: ['input'] },
    { key: 'transfer', label: 'Transfer', types: ['transfer', 'handoff'] },
    { key: 'queue', label: 'Queue', types: ['queue'] },
    { key: 'booking', label: 'Booking', types: ['availability_check', 'slot_offer', 'booking_confirm', 'booking_create'] },
    { key: 'whatsapp', label: 'WhatsApp', types: ['whatsapp_notify'] },
    { key: 'voicemail', label: 'Voicemail', types: ['voicemail'] }
];

const normalizeType = (value) => String(value || '').trim().toLowerCase();

const resolveNodeLabel = (node = {}) => {
    const data = node.data || {};
    return (
        String(
            data.label ||
            data.title ||
            data.name ||
            data.messageText ||
            data.text ||
            node.label ||
            node.name ||
            ''
        ).trim() ||
        normalizeType(node.type).replace(/_/g, ' ') ||
        node.id ||
        'Unknown node'
    );
};

const resolveNodeSummary = (node = {}) => {
    const data = node.data || {};
    const type = normalizeType(node.type);

    if (type === 'audio' || type === 'greeting') {
        return [
            data.mode ? `Mode ${data.mode}` : null,
            data.voice ? `Voice ${data.voice}` : null,
            data.language ? `Language ${data.language}` : null,
            data.afterPlayback ? `After ${data.afterPlayback}` : null,
            data.maxRetries ?? data.max_retries ? `Retries ${data.maxRetries ?? data.max_retries}` : null
        ].filter(Boolean).join(' • ') || 'Audio prompt configured';
    }

    if (type === 'input') {
        return [
            data.digit ? `Digit ${data.digit}` : null,
            data.action ? `Action ${data.action}` : null,
            data.timeoutSeconds ?? data.timeout ? `Timeout ${data.timeoutSeconds ?? data.timeout}` : null,
            data.maxAttempts ?? data.max_attempts ? `Attempts ${data.maxAttempts ?? data.max_attempts}` : null
        ].filter(Boolean).join(' • ') || 'Input routing configured';
    }

    if (type === 'conditional') {
        return [
            data.condition ? `Condition ${data.condition}` : null,
            data.variable ? `Variable ${data.variable}` : null,
            data.operator ? `Operator ${data.operator}` : null,
            data.value ? `Value ${data.value}` : null
        ].filter(Boolean).join(' • ') || 'Conditional routing';
    }

    if (type === 'transfer' || type === 'handoff') {
        return [
            data.destination || data.transferNumber ? `Destination ${data.destination || data.transferNumber}` : null,
            data.department ? `Department ${data.department}` : null,
            data.timeout ? `Timeout ${data.timeout}` : null
        ].filter(Boolean).join(' • ') || 'Transfer routing';
    }

    if (type === 'queue') {
        return [
            data.queueName || data.queue_name ? `Queue ${data.queueName || data.queue_name}` : null,
            data.workflowSid || data.workflow_sid ? `Workflow ${data.workflowSid || data.workflow_sid}` : null
        ].filter(Boolean).join(' • ') || 'Queue routing';
    }

    if (type === 'availability_check') {
        return [
            data.promptText || data.prompt_text ? `Prompt ${data.promptText || data.prompt_text}` : null,
            data.timezone ? `Timezone ${data.timezone}` : null,
            data.numDigits ?? data.num_digits ? `Digits ${data.numDigits ?? data.num_digits}` : null,
            data.maxRetries ?? data.max_retries ? `Retries ${data.maxRetries ?? data.max_retries}` : null
        ].filter(Boolean).join(' • ') || 'Availability check';
    }

    if (type === 'slot_offer') {
        return [
            data.promptText || data.prompt_text ? `Prompt ${data.promptText || data.prompt_text}` : null,
            data.offerText || data.offer_text ? `Offer ${data.offerText || data.offer_text}` : null,
            data.yesDigits || data.yes_digits ? `Yes ${data.yesDigits || data.yes_digits}` : null,
            data.noDigits || data.no_digits ? `No ${data.noDigits || data.no_digits}` : null
        ].filter(Boolean).join(' • ') || 'Slot offer';
    }

    if (type === 'booking_confirm') {
        return [
            data.promptText || data.prompt_text ? `Prompt ${data.promptText || data.prompt_text}` : null,
            data.yesDigits || data.yes_digits ? `Yes ${data.yesDigits || data.yes_digits}` : null,
            data.noDigits || data.no_digits ? `No ${data.noDigits || data.no_digits}` : null
        ].filter(Boolean).join(' • ') || 'Booking confirmation';
    }

    if (type === 'booking_create') {
        return [
            data.bookingReferencePrefix || data.booking_reference_prefix ? `Prefix ${data.bookingReferencePrefix || data.booking_reference_prefix}` : null,
            data.tokenPrefix || data.token_prefix ? `Token ${data.tokenPrefix || data.token_prefix}` : null,
            data.preventDuplicates ?? data.prevent_duplicates ? 'Duplicate guard enabled' : null
        ].filter(Boolean).join(' • ') || 'Booking creation';
    }

    if (type === 'whatsapp_notify') {
        return [
            data.customerRecipient || data.customer_recipient ? `Customer ${data.customerRecipient || data.customer_recipient}` : null,
            data.adminRecipient || data.admin_recipient ? `Admin ${data.adminRecipient || data.admin_recipient}` : null,
            data.customerTemplateName || data.customer_template_name ? `Customer template ${data.customerTemplateName || data.customer_template_name}` : null,
            data.adminTemplateName || data.admin_template_name ? `Admin template ${data.adminTemplateName || data.admin_template_name}` : null
        ].filter(Boolean).join(' • ') || 'WhatsApp notify';
    }

    if (type === 'voicemail') {
        return [
            data.mailbox ? `Mailbox ${data.mailbox}` : null,
            data.transcription ?? data.transcribe ? 'Transcription on' : null
        ].filter(Boolean).join(' • ') || 'Voicemail';
    }

    if (type === 'end') {
        return [
            data.reason || data.terminationType ? `Reason ${data.reason || data.terminationType}` : null,
            data.callbackDelay || data.callback_delay ? `Callback ${data.callbackDelay || data.callback_delay}` : null
        ].filter(Boolean).join(' • ') || 'End call';
    }

    return resolveNodeLabel(node);
};

const buildCapabilityState = (workflow = {}) => {
    const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes.filter(Boolean) : [];
    const nodesByType = nodes.reduce((acc, node) => {
        const type = normalizeType(node.type);
        if (!type) return acc;
        if (!acc[type]) acc[type] = [];
        acc[type].push(node);
        return acc;
    }, {});

    const capabilities = WORKFLOW_CAPABILITY_DEFS
        .map((definition) => ({
            ...definition,
            nodes: definition.types.flatMap((type) => nodesByType[type] || []),
            enabled: definition.types.some((type) => Boolean(nodesByType[type]?.length))
        }))
        .filter((capability) => capability.enabled);

    return {
        capabilities,
        nodes,
        nodesByType,
        nodeCount: nodes.length,
        edgeCount: Array.isArray(workflow?.edges) ? workflow.edges.length : 0
    };
};

const formatDurationLabel = (duration = 0) => {
    const totalSeconds = Math.max(0, Math.floor(Number(duration || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
};

class IVRAnalyticsService {
    /**
     * Get aggregated execution statistics for a workflow
     */
    async getWorkflowStats(workflowId, startDate, endDate, userId = null) {
        try {
            const query = { workflowId, ...(userId ? { userId } : {}) };
            if (startDate || endDate) {
                query.startTime = {};
                if (startDate) query.startTime.$gte = parseDateOnlyInTimezone(startDate, VOICE_TIME_ZONE, false);
                if (endDate) query.startTime.$lte = parseDateOnlyInTimezone(endDate, VOICE_TIME_ZONE, true);
            }

            const executions = await ExecutionLog.find(query).lean();
            const total = executions.length;
            const completed = executions.filter((e) => e.status === 'completed').length;
            const failed = executions.filter((e) => e.status === 'failed').length;
            const timeout = executions.filter((e) => e.status === 'timeout').length;
            const totalDuration = executions.reduce((sum, e) => sum + (e.duration || 0), 0);
            return {
                totalExecutions: total,
                completedExecutions: completed,
                failedExecutions: failed,
                timeoutExecutions: timeout,
                averageDuration: total > 0 ? totalDuration / total : 0
            };
        } catch (error) {
            logger.error('Error getting workflow stats:', error);
            throw error;
        }
    }

    async getWorkflowEventLog(workflowId, startDate, endDate, limit = 250, userId = null) {
        try {
            const workflow = await Workflow.findOne({
                _id: workflowId,
                ...(userId ? { createdBy: userId } : {})
            }).lean();

            if (!workflow) {
                throw new Error('Workflow not found');
            }

            const query = {
                workflowId: workflow._id,
                ...(userId ? { userId } : {})
            };

            if (startDate || endDate) {
                query.startTime = {};
                if (startDate) query.startTime.$gte = parseDateOnlyInTimezone(startDate, VOICE_TIME_ZONE, false);
                if (endDate) query.startTime.$lte = parseDateOnlyInTimezone(endDate, VOICE_TIME_ZONE, true);
            }

            const executions = await ExecutionLog.find(query)
                .sort({ startTime: -1, createdAt: -1 })
                .limit(Math.max(1, Number(limit) || 250))
                .lean();

            const executionCallSids = executions.map((execution) => String(execution.callSid || '').trim()).filter(Boolean);
            const [bookings, queueCalls] = await Promise.all([
                executionCallSids.length > 0
                    ? AppointmentBooking.find({
                        workflowId: workflow._id,
                        callSid: { $in: executionCallSids }
                    }).lean()
                    : [],
                executionCallSids.length > 0
                    ? Call.find({
                        callSid: { $in: executionCallSids },
                        ...(userId ? { user: userId } : {})
                    })
                        .select('callSid queueName queueEnteredAt queueLeftAt queuePosition queueWaitTime queueResult queued')
                        .lean()
                    : []
            ]);

            const bookingIds = bookings.map((booking) => booking._id).filter(Boolean);
            const notifications = bookingIds.length > 0
                ? await BookingNotificationLog.find({
                    workflowId: workflow._id,
                    bookingId: { $in: bookingIds }
                })
                    .sort({ createdAt: -1 })
                    .lean()
                : [];

            const bookingByCallSid = new Map();
            bookings.forEach((booking) => {
                if (!booking?.callSid) return;
                bookingByCallSid.set(String(booking.callSid), booking);
            });

            const queueByCallSid = new Map();
            queueCalls.forEach((queueCall) => {
                if (!queueCall?.callSid) return;
                queueByCallSid.set(String(queueCall.callSid), queueCall);
            });

            const notificationsByBookingId = new Map();
            notifications.forEach((notification) => {
                const key = String(notification.bookingId || '');
                if (!key) return;
                if (!notificationsByBookingId.has(key)) {
                    notificationsByBookingId.set(key, { customer: null, admin: null, all: [] });
                }
                const bucket = notificationsByBookingId.get(key);
                bucket.all.push(notification);
                if (notification.channel === 'customer' && !bucket.customer) {
                    bucket.customer = notification;
                }
                if (notification.channel === 'admin' && !bucket.admin) {
                    bucket.admin = notification;
                }
            });

            const capabilityState = buildCapabilityState(workflow);
            const nodesById = new Map((Array.isArray(workflow.nodes) ? workflow.nodes : []).map((node) => [String(node.id), node]));

            const buildNotificationStatus = (notification = null) => {
                if (!notification) return 'not sent';
                return String(notification.status || 'not sent').toLowerCase();
            };

            const rows = executions.map((execution) => {
                const visitedNodes = Array.isArray(execution.visitedNodes) ? execution.visitedNodes : [];
                const lastVisit = visitedNodes.length > 0 ? visitedNodes[visitedNodes.length - 1] : null;
                const firstVisit = visitedNodes.length > 0 ? visitedNodes[0] : null;
                const currentNode = lastVisit?.nodeId ? nodesById.get(String(lastVisit.nodeId)) || null : null;
                const entryNode = firstVisit?.nodeId ? nodesById.get(String(firstVisit.nodeId)) || null : null;
                const booking = bookingByCallSid.get(String(execution.callSid || '')) || null;
                const queueRecord = queueByCallSid.get(String(execution.callSid || '')) || null;
                const bookingNotifications = booking?._id ? notificationsByBookingId.get(String(booking._id)) || null : null;
                const customerNotification = bookingNotifications?.customer || null;
                const adminNotification = bookingNotifications?.admin || null;
                const currentNodeLabel = resolveNodeLabel(currentNode || {});
                const entryNodeLabel = resolveNodeLabel(entryNode || {});
                const visitedPath = visitedNodes.map((visit) => resolveNodeLabel(nodesById.get(String(visit.nodeId)) || {
                    id: visit.nodeId,
                    type: visit.nodeType,
                    data: {}
                }));
                const rawStatus = String(execution.status || 'running').toLowerCase();
                const terminalNodeType = normalizeType(lastVisit?.nodeType || currentNode?.type || '');
                const lastActivityAt = new Date(
                    lastVisit?.timestamp ||
                    execution.updatedAt ||
                    execution.startTime ||
                    Date.now()
                ).getTime();
                const isStaleRunning =
                    rawStatus === 'running' &&
                    Number.isFinite(lastActivityAt) &&
                    Date.now() - lastActivityAt > STALE_RUNNING_EXECUTION_MS;
                const status = rawStatus === 'running' && terminalNodeType === 'end'
                    ? 'completed'
                    : (isStaleRunning ? 'abandoned' : rawStatus);
                const bookingStatus = booking ? String(booking.status || 'confirmed').toLowerCase() : 'not booked';
                const finalResult = booking
                    ? (booking.status === 'cancelled'
                        ? 'Cancelled'
                        : booking.status === 'rejected'
                            ? 'Rejected'
                            : 'Booked')
                        : (status === 'completed'
                            ? 'Completed'
                            : status === 'failed'
                                ? 'Failed'
                                : status === 'timeout'
                                    ? 'Timed out'
                                    : status === 'abandoned'
                                        ? 'Abandoned'
                                : 'Running');
                const bookingState = booking
                    ? {
                        id: String(booking._id),
                        status: bookingStatus,
                        reference: booking.bookingReference || '',
                        tokenNumber: booking.tokenNumber || '',
                        slotLabel: booking.slotLabel || '',
                        slotDate: booking.slotDate || '',
                        customerName: booking.customerName || '',
                        customerPhone: booking.customerPhone || '',
                        notes: booking.notes || ''
                    }
                    : null;

                const whatsappState = booking
                    ? {
                        customer: buildNotificationStatus(customerNotification),
                        admin: buildNotificationStatus(adminNotification),
                        providerMessageId: customerNotification?.providerMessageId || adminNotification?.providerMessageId || '',
                        templateName: customerNotification?.templateName || adminNotification?.templateName || ''
                    }
                    : null;

                const queueState = queueRecord
                    ? {
                        name: queueRecord.queueName || '',
                        position: Number(queueRecord.queuePosition || 0),
                        waitTime: Number(queueRecord.queueWaitTime || 0),
                        enteredAt: queueRecord.queueEnteredAt || null,
                        leftAt: queueRecord.queueLeftAt || null,
                        result: queueRecord.queueResult || '',
                        queued: Boolean(queueRecord.queued)
                    }
                    : null;

                return {
                    id: String(execution._id || execution.callSid || `${execution.workflowId}-${execution.startTime || Date.now()}`),
                    callSid: execution.callSid || null,
                    workflowId: String(execution.workflowId || workflow._id || ''),
                    callTime: execution.startTime || execution.createdAt || null,
                    startedAt: execution.startTime || execution.createdAt || null,
                    endedAt: execution.endTime || null,
                    durationMs: Number(execution.duration || 0),
                    durationLabel: formatDurationLabel(execution.duration || 0),
                    callerNumber: execution.callerNumber || '-',
                    destinationNumber: execution.destinationNumber || '-',
                    callStatus: status,
                    finalResult,
                    currentNodeId: lastVisit?.nodeId || null,
                    currentNodeType: terminalNodeType,
                    currentNodeLabel,
                    entryNodeId: firstVisit?.nodeId || null,
                    entryNodeType: normalizeType(firstVisit?.nodeType || entryNode?.type || ''),
                    entryNodeLabel,
                    lastInput: lastVisit?.userInput || execution.userInputs?.[execution.userInputs.length - 1]?.input || '',
                    visitedPath,
                    visitedPathLabel: visitedPath.filter(Boolean).join(' → ') || '—',
                    nodeExecutionCount: execution.nodeExecutionCount || visitedNodes.length || 0,
                    loopIterations: execution.loopIterations || 0,
                    reason: execution.reason || '',
                    errorMessage: execution.errorMessage || '',
                    transferAttempted: Boolean(execution.transferAttempted),
                    transferDestination: execution.transferDestination || '',
                    queueName: queueState?.name || '',
                    queuePosition: queueState?.position || 0,
                    queueWaitTime: queueState?.waitTime || 0,
                    queueEnteredAt: queueState?.enteredAt || null,
                    queueLeftAt: queueState?.leftAt || null,
                    queueResult: queueState?.result || '',
                    voicemailRecorded: Boolean(execution.voicemailRecorded),
                    recordingUrl: execution.recordingUrl || '',
                    bookingState,
                    bookingStatus,
                    bookingReference: bookingState?.reference || '',
                    tokenNumber: bookingState?.tokenNumber || '',
                    slotLabel: bookingState?.slotLabel || '',
                    slotDate: bookingState?.slotDate || '',
                    customerName: bookingState?.customerName || '',
                    customerPhone: bookingState?.customerPhone || '',
                    bookingNotes: bookingState?.notes || '',
                    customerWhatsAppStatus: whatsappState?.customer || 'not sent',
                    adminWhatsAppStatus: whatsappState?.admin || 'not sent',
                    whatsappState,
                    queueState,
                    booking,
                    currentNode: currentNode
                        ? {
                            id: String(currentNode.id || ''),
                            type: currentNode.type || '',
                            label: currentNodeLabel,
                            summary: resolveNodeSummary(currentNode)
                        }
                        : null,
                    entryNode: entryNode
                        ? {
                            id: String(entryNode.id || ''),
                            type: entryNode.type || '',
                            label: entryNodeLabel,
                            summary: resolveNodeSummary(entryNode)
                        }
                        : null,
                    nodeTrail: visitedNodes.map((visit) => ({
                        nodeId: visit.nodeId || '',
                        nodeType: normalizeType(visit.nodeType || ''),
                        label: resolveNodeLabel(nodesById.get(String(visit.nodeId)) || {
                            id: visit.nodeId,
                            type: visit.nodeType
                        }),
                        userInput: visit.userInput || '',
                        timestamp: visit.timestamp || null,
                        duration: visit.duration || 0
                    })),
                    capabilities: capabilityState.capabilities.map((capability) => capability.key)
                };
            });

            const summary = {
                totalCalls: rows.length,
                activeCalls: rows.filter((row) => row.callStatus === 'running').length,
                completedCalls: rows.filter((row) => row.callStatus === 'completed').length,
                failedCalls: rows.filter((row) => row.callStatus === 'failed').length,
                timeoutCalls: rows.filter((row) => row.callStatus === 'timeout').length,
                bookedCalls: rows.filter((row) => ['reserved', 'confirmed'].includes(row.bookingStatus)).length,
                cancelledCalls: rows.filter((row) => row.bookingStatus === 'cancelled').length,
                rejectedCalls: rows.filter((row) => row.bookingStatus === 'rejected').length,
                whatsappSent: rows.filter((row) => row.customerWhatsAppStatus === 'sent' || row.adminWhatsAppStatus === 'sent').length,
                whatsappFailed: rows.filter((row) => row.customerWhatsAppStatus === 'failed' || row.adminWhatsAppStatus === 'failed').length,
                transfers: rows.filter((row) => row.transferAttempted || row.transferDestination).length,
                voicemailCalls: rows.filter((row) => row.voicemailRecorded).length,
                queuedCalls: rows.filter((row) => String(row.queueName || '').trim() || Number(row.queuePosition || 0) > 0 || Number(row.queueWaitTime || 0) > 0).length,
                avgQueueWaitSeconds: rows.filter((row) => Number(row.queueWaitTime || 0) > 0).reduce((sum, row) => sum + Number(row.queueWaitTime || 0), 0) / Math.max(1, rows.filter((row) => Number(row.queueWaitTime || 0) > 0).length),
                maxQueueWaitSeconds: rows.reduce((max, row) => Math.max(max, Number(row.queueWaitTime || 0)), 0)
            };

            const columns = [
                { key: 'callTime', label: 'Call Time', type: 'datetime', group: 'core' },
                { key: 'callerNumber', label: 'Caller', type: 'phone', group: 'core' },
                { key: 'callStatus', label: 'Status', type: 'status', group: 'core' },
                { key: 'currentNodeLabel', label: 'Current Node', type: 'node', group: 'core' },
                { key: 'visitedPathLabel', label: 'Path', type: 'path', group: 'core' },
                { key: 'durationLabel', label: 'Duration', type: 'duration', group: 'core' },
                { key: 'finalResult', label: 'Result', type: 'result', group: 'core' },
                { key: 'lastInput', label: 'Last Input', type: 'input', group: 'input' },
                { key: 'entryNodeLabel', label: 'Entry Node', type: 'node', group: 'audio' },
                { key: 'transferDestination', label: 'Transfer To', type: 'text', group: 'transfer' },
                { key: 'queueName', label: 'Queue', type: 'text', group: 'queue' },
                { key: 'queuePosition', label: 'Queue Position', type: 'number', group: 'queue' },
                { key: 'queueWaitTime', label: 'Queue Wait', type: 'duration', group: 'queue' },
                { key: 'queueEnteredAt', label: 'Queue Entered', type: 'datetime', group: 'queue' },
                { key: 'queueLeftAt', label: 'Queue Left', type: 'datetime', group: 'queue' },
                { key: 'queueResult', label: 'Queue Result', type: 'status', group: 'queue' },
                { key: 'bookingStatus', label: 'Booking Status', type: 'status', group: 'booking' },
                { key: 'bookingReference', label: 'Booking Ref', type: 'text', group: 'booking' },
                { key: 'slotLabel', label: 'Slot', type: 'text', group: 'booking' },
                { key: 'slotDate', label: 'Slot Date', type: 'date', group: 'booking' },
                { key: 'tokenNumber', label: 'Token', type: 'text', group: 'booking' },
                { key: 'customerWhatsAppStatus', label: 'Customer WhatsApp', type: 'status', group: 'whatsapp' },
                { key: 'adminWhatsAppStatus', label: 'Admin WhatsApp', type: 'status', group: 'whatsapp' },
                { key: 'voicemailRecorded', label: 'Voicemail', type: 'boolean', group: 'voicemail' }
            ].filter((column) => {
                if (column.group === 'input') return capabilityState.capabilities.some((capability) => capability.key === 'input');
                if (column.group === 'audio') return capabilityState.capabilities.some((capability) => capability.key === 'audio');
                if (column.group === 'transfer') return capabilityState.capabilities.some((capability) => capability.key === 'transfer');
                if (column.group === 'queue') return capabilityState.capabilities.some((capability) => capability.key === 'queue');
                if (column.group === 'booking') return capabilityState.capabilities.some((capability) => capability.key === 'booking');
                if (column.group === 'whatsapp') return capabilityState.capabilities.some((capability) => capability.key === 'whatsapp');
                if (column.group === 'voicemail') return capabilityState.capabilities.some((capability) => capability.key === 'voicemail');
                return true;
            });

            return {
                workflow: {
                    _id: String(workflow._id),
                    promptKey: workflow.promptKey || '',
                    displayName: workflow.displayName || workflow.name || workflow.promptKey || '',
                    status: workflow.status || 'draft',
                    nodes: workflow.nodes || [],
                    edges: workflow.edges || [],
                    updatedAt: workflow.updatedAt || null,
                    createdAt: workflow.createdAt || null,
                    capabilities: capabilityState.capabilities.map((capability) => ({
                        key: capability.key,
                        label: capability.label,
                        nodeCount: capability.nodes.length
                    }))
                },
                columns,
                rows,
                summary,
                dateRange: {
                    startDate: startDate || null,
                    endDate: endDate || null
                }
            };
        } catch (error) {
            logger.error('Error getting workflow event log:', error);
            throw error;
        }
    }

    /**
     * Get recent executions for a workflow
     */
    async getRecentExecutions(workflowId, limit = 50, userId = null) {
        try {
            return await ExecutionLog.find({ workflowId, ...(userId ? { userId } : {}) })
                .sort({ createdAt: -1 })
                .limit(limit)
                .select('-__v');
        } catch (error) {
            logger.error('Error getting recent executions:', error);
            throw error;
        }
    }

    /**
     * Get detailed execution log by CallSid
     */
    async getExecutionDetails(callSid, userId = null) {
        try {
            return await ExecutionLog.findOne({ callSid, ...(userId ? { userId } : {}) });
        } catch (error) {
            logger.error('Error getting execution details:', error);
            throw error;
        }
    }

    /**
     * Get node-level analytics (heatmap data)
     */
    async getNodeAnalytics(workflowId, userId = null) {
        try {
            const workflow = await Workflow.findOne({ _id: workflowId, ...(userId ? { createdBy: userId } : {}) });
            if (!workflow) throw new Error('Workflow not found');

            const aggregation = await ExecutionLog.aggregate([
                { $match: { workflowId: workflow._id, ...(userId ? { userId } : {}) } },
                { $unwind: '$visitedNodes' },
                {
                    $group: {
                        _id: '$visitedNodes.nodeId',
                        count: { $sum: 1 },
                        avgDuration: { $avg: '$visitedNodes.duration' },
                        uniqueCallers: { $addToSet: '$callSid' }
                    }
                },
                {
                    $project: {
                        nodeId: '$_id',
                        count: 1,
                        avgDuration: 1,
                        uniqueCallers: { $size: '$uniqueCallers' }
                    }
                }
            ]);

            // Map back to node IDs for frontend consumption
            const nodeStats = {};
            aggregation.forEach(stat => {
                nodeStats[stat.nodeId] = {
                    visits: stat.count,
                    uniqueUsers: stat.uniqueCallers,
                    avgDropoff: 0 // Placeholder for dropoff calculation
                };
            });

            return nodeStats;
        } catch (error) {
            logger.error('Error getting node analytics:', error);
            throw error;
        }
    }

    /**
     * Get Real-time active calls
     */
    async getActiveCalls(userId = null) {
        try {
            const runningExecutions = await ExecutionLog.find({ status: 'running', ...(userId ? { userId } : {}) })
                .sort({ startTime: -1, createdAt: -1 })
                .lean();

            return runningExecutions.filter((execution) => {
                const visitedNodes = Array.isArray(execution.visitedNodes) ? execution.visitedNodes : [];
                const lastVisit = visitedNodes.length > 0 ? visitedNodes[visitedNodes.length - 1] : null;
                const lastNodeType = normalizeType(lastVisit?.nodeType || '');
                return lastNodeType !== 'end';
            });
        } catch (error) {
            logger.error('Error getting active calls:', error);
            throw error;
        }
    }
}

export default new IVRAnalyticsService();
