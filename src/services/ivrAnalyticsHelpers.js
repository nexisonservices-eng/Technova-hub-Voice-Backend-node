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

const normalizeStatus = (value) => String(value || '').trim().toLowerCase();

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
      data.customerTemplateName || data.customer_template_name || data.requestedTemplateName ? `Customer template ${data.customerTemplateName || data.customer_template_name || data.requestedTemplateName}` : null,
      data.adminTemplateName || data.admin_template_name || data.requestedTemplateName ? `Admin template ${data.adminTemplateName || data.admin_template_name || data.requestedTemplateName}` : null,
      'Template-first with text fallback'
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

  return 'No additional configuration';
};

const buildCapabilityState = (workflow = {}) => {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes.filter(Boolean) : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges.filter(Boolean) : [];
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
    capabilityMap: capabilities.reduce((acc, capability) => {
      acc[capability.key] = capability;
      return acc;
    }, {}),
    nodes,
    nodesByType,
    nodeCount: nodes.length,
    edgeCount: edges.length
  };
};

const buildWorkflowEventLogColumns = (capabilityState = {}) => {
  const capabilityKeys = new Set((capabilityState.capabilities || []).map((capability) => capability.key));
  return [
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
    { key: 'customerWhatsAppTemplateName', label: 'Customer Template', type: 'text', group: 'whatsapp' },
    { key: 'customerWhatsAppDeliveryMode', label: 'Customer Mode', type: 'text', group: 'whatsapp' },
    { key: 'customerWhatsAppError', label: 'Customer Error', type: 'text', group: 'whatsapp' },
    { key: 'adminWhatsAppStatus', label: 'Admin WhatsApp', type: 'status', group: 'whatsapp' },
    { key: 'adminWhatsAppTemplateName', label: 'Admin Template', type: 'text', group: 'whatsapp' },
    { key: 'adminWhatsAppDeliveryMode', label: 'Admin Mode', type: 'text', group: 'whatsapp' },
    { key: 'adminWhatsAppError', label: 'Admin Error', type: 'text', group: 'whatsapp' },
    { key: 'voicemailRecorded', label: 'Voicemail', type: 'boolean', group: 'voicemail' }
  ].filter((column) => {
    if (column.group === 'core') return true;
    if (column.group === 'input') return capabilityKeys.has('input');
    if (column.group === 'audio') return capabilityKeys.has('audio');
    if (column.group === 'transfer') return capabilityKeys.has('transfer');
    if (column.group === 'queue') return capabilityKeys.has('queue');
    if (column.group === 'booking') return capabilityKeys.has('booking');
    if (column.group === 'whatsapp') return capabilityKeys.has('whatsapp');
    if (column.group === 'voicemail') return capabilityKeys.has('voicemail');
    return true;
  });
};

const buildWorkflowEventLogSummary = (rows = []) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  const queueWaitSeconds = safeRows
    .map((row) => Number(row.queueWaitTime || 0))
    .filter((value) => Number.isFinite(value) && value > 0);

  const totalQueueWait = queueWaitSeconds.reduce((sum, value) => sum + value, 0);

  return {
    totalCalls: safeRows.length,
    activeCalls: safeRows.filter((row) => normalizeStatus(row.callStatus) === 'running').length,
    completedCalls: safeRows.filter((row) => normalizeStatus(row.callStatus) === 'completed').length,
    failedCalls: safeRows.filter((row) => normalizeStatus(row.callStatus) === 'failed').length,
    timeoutCalls: safeRows.filter((row) => normalizeStatus(row.callStatus) === 'timeout').length,
    bookedCalls: safeRows.filter((row) => ['reserved', 'confirmed'].includes(normalizeStatus(row.bookingStatus))).length,
    cancelledCalls: safeRows.filter((row) => normalizeStatus(row.bookingStatus) === 'cancelled').length,
    rejectedCalls: safeRows.filter((row) => normalizeStatus(row.bookingStatus) === 'rejected').length,
    whatsappSent: safeRows.filter((row) => normalizeStatus(row.customerWhatsAppStatus) === 'sent' || normalizeStatus(row.adminWhatsAppStatus) === 'sent').length,
    whatsappFailed: safeRows.filter((row) => normalizeStatus(row.customerWhatsAppStatus) === 'failed' || normalizeStatus(row.adminWhatsAppStatus) === 'failed').length,
    transfers: safeRows.filter((row) => row.transferAttempted || row.transferDestination).length,
    voicemailCalls: safeRows.filter((row) => row.voicemailRecorded).length,
    queuedCalls: safeRows.filter((row) => String(row.queueName || '').trim() || Number(row.queuePosition || 0) > 0 || Number(row.queueWaitTime || 0) > 0).length,
    avgQueueWaitSeconds: queueWaitSeconds.length > 0 ? totalQueueWait / queueWaitSeconds.length : 0,
    maxQueueWaitSeconds: queueWaitSeconds.length > 0 ? Math.max(...queueWaitSeconds) : 0
  };
};

export {
  WORKFLOW_CAPABILITY_DEFS,
  buildCapabilityState,
  buildWorkflowEventLogColumns,
  buildWorkflowEventLogSummary,
  normalizeStatus,
  normalizeType,
  resolveNodeLabel,
  resolveNodeSummary
};
