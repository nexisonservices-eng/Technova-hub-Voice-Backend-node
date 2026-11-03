const idString = (value) => String(value?._id || value || '').trim();
const SID_PATTERN = /^CA[a-f\d]{32}$/i;

export const createRelaySessionContext = ({ userId, workflowId, nodeId }) => ({
  authenticated: true,
  userId: idString(userId),
  workflowId: idString(workflowId),
  nodeId: String(nodeId || ''),
  setupReceived: false,
  callSid: ''
});

export const bindRelaySetupCallSid = (session, message, { execution, call = null } = {}) => {
  if (!session?.authenticated || !session.userId || !session.workflowId) {
    return { valid: false, reason: 'invalid_session' };
  }
  if (message?.type !== 'setup') return { valid: false, reason: 'setup_required' };

  // Twilio ConversationRelay's documented setup field is `callSid`.
  // Accept `CallSid` as a compatibility alias, but never read a SID from prompt messages.
  const callSid = String(message.callSid || message.CallSid || '').trim();
  if (!SID_PATTERN.test(callSid)) return { valid: false, reason: 'malformed_call_sid' };
  if (!execution) return { valid: false, reason: 'execution_not_found' };

  if (String(execution.callSid || '') !== callSid) return { valid: false, reason: 'execution_call_mismatch' };
  if (idString(execution.userId) !== session.userId) return { valid: false, reason: 'wrong_tenant' };
  if (idString(execution.workflowId) !== session.workflowId) return { valid: false, reason: 'wrong_workflow' };

  if (call) {
    if (String(call.provider || '').toLowerCase() !== 'twilio') return { valid: false, reason: 'wrong_provider' };
    if (idString(call.user) !== session.userId) return { valid: false, reason: 'wrong_tenant' };
    const callWorkflowId = idString(call.providerData?.workflowId);
    if (callWorkflowId && callWorkflowId !== session.workflowId) return { valid: false, reason: 'wrong_workflow' };
  }

  session.callSid = callSid;
  session.setupReceived = true;
  return { valid: true, callSid };
};

export const getRelaySessionCallSid = (session) =>
  session?.authenticated && session?.setupReceived && SID_PATTERN.test(session.callSid)
    ? session.callSid
    : '';

export const resolveCallOwnerFromRecords = ({
  callSid, tenantUserId = '', queryUserId = '', workflowId = '', call = null, execution = null
}) => {
  const normalizedSid = String(callSid || '').trim();
  if (!SID_PATTERN.test(normalizedSid)) return { valid: false, reason: 'malformed_call_sid' };

  const ownerId = call?.user ? idString(call.user) : execution?.userId ? idString(execution.userId) : '';
  if (!ownerId) return { valid: false, reason: 'call_owner_not_found' };
  if (call && String(call.provider || '').toLowerCase() !== 'twilio' && !(execution && !call.provider)) {
    return { valid: false, reason: 'wrong_provider' };
  }
  if (call && String(call.callSid || '') !== normalizedSid) return { valid: false, reason: 'call_record_mismatch' };
  if (execution && String(execution.callSid || '') !== normalizedSid) return { valid: false, reason: 'execution_call_mismatch' };
  if (execution && idString(execution.userId) !== ownerId) return { valid: false, reason: 'record_owner_mismatch' };
  if (tenantUserId && idString(tenantUserId) !== ownerId) return { valid: false, reason: 'wrong_tenant' };
  if (queryUserId && idString(queryUserId) !== ownerId) return { valid: false, reason: 'wrong_tenant' };

  const callWorkflowId = idString(call?.providerData?.workflowId);
  const executionWorkflowId = idString(execution?.workflowId);
  if (workflowId && callWorkflowId && callWorkflowId !== idString(workflowId)) return { valid: false, reason: 'wrong_workflow' };
  if (workflowId && executionWorkflowId && executionWorkflowId !== idString(workflowId)) return { valid: false, reason: 'wrong_workflow' };
  if (!call && !execution) return { valid: false, reason: 'call_record_not_found' };

  return { valid: true, userId: ownerId };
};
