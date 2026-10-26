const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

export const resolveConnectedHandoffDestination = (workflow, aiVoiceAgentNodeId) => {
  const edge = (workflow?.edges || []).find((candidate) =>
    candidate.source === aiVoiceAgentNodeId && candidate.sourceHandle === 'transferred'
  );
  if (!edge) return { destination: '', handoffNodeId: '', reason: 'transferred_edge_missing' };

  const handoffNode = (workflow?.nodes || []).find((candidate) => candidate.id === edge.target);
  if (!handoffNode || !['handoff', 'transfer'].includes(String(handoffNode.type || '').toLowerCase())) {
    return { destination: '', handoffNodeId: String(edge.target || ''), reason: 'handoff_node_missing' };
  }

  const data = handoffNode.data || {};
  const destination = String(data.destination || data.transferNumber || data.transfer_number || '').trim();
  if (!E164_PHONE_PATTERN.test(destination)) {
    return { destination: '', handoffNodeId: handoffNode.id, reason: 'handoff_destination_invalid' };
  }

  return { destination, handoffNodeId: handoffNode.id, reason: '' };
};

export const resolveAIVoiceTransferContinuation = (workflow, aiVoiceAgentNodeId, succeeded) => {
  const aiHandle = succeeded ? 'transferred' : 'error';
  const aiEdge = (workflow?.edges || []).find((candidate) =>
    candidate.source === aiVoiceAgentNodeId && candidate.sourceHandle === aiHandle
  );
  if (!aiEdge) return '';

  const nextNode = (workflow?.nodes || []).find((candidate) => candidate.id === aiEdge.target);
  const nodeType = String(nextNode?.type || '').toLowerCase();
  if (!succeeded || !['handoff', 'transfer'].includes(nodeType)) return aiEdge.target;

  const successHandle = nodeType === 'handoff' ? 'connected' : 'answered';
  const continuationEdge = (workflow?.edges || []).find((candidate) =>
    candidate.source === nextNode.id && candidate.sourceHandle === successHandle
  );
  return continuationEdge?.target || '';
};
