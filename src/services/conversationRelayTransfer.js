const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

export const resolveConnectedHandoffDestination = (workflow, aiVoiceAgentNodeId) => {
  const edges = (workflow?.edges || []).filter((candidate) =>
    candidate.source === aiVoiceAgentNodeId && ['transferred', 'completed'].includes(candidate.sourceHandle)
  );
  if (!edges.length) return { destination: '', handoffNodeId: '', reason: 'transfer_or_completed_edge_missing' };

  // Older saved workflows use `completed` for the explicit AI Agent → Hand Off
  // connection. Accept it only if it targets a Hand Off/Transfer node.
  const handoffNode = edges
    .map((edge) => (workflow?.nodes || []).find((candidate) => candidate.id === edge.target))
    .find((candidate) => ['handoff', 'transfer'].includes(String(candidate?.type || '').toLowerCase()));
  if (!handoffNode) return { destination: '', handoffNodeId: '', reason: 'connected_handoff_node_missing' };

  const data = handoffNode.data || {};
  const destination = String(data.destination || data.transferNumber || data.transfer_number || '').trim();
  if (!E164_PHONE_PATTERN.test(destination)) {
    return { destination: '', handoffNodeId: handoffNode.id, reason: 'handoff_destination_invalid' };
  }

  return { destination, handoffNodeId: handoffNode.id, reason: '' };
};

export const resolveAIVoiceTransferContinuation = (workflow, aiVoiceAgentNodeId, succeeded) => {
  const handles = succeeded ? ['transferred', 'completed'] : ['error'];
  const edges = handles.map((handle) => (workflow?.edges || []).find((candidate) =>
    candidate.source === aiVoiceAgentNodeId && candidate.sourceHandle === handle
  )).filter(Boolean);
  const aiEdge = succeeded
    ? edges.find((edge) => ['handoff', 'transfer'].includes(String(
      (workflow?.nodes || []).find((candidate) => candidate.id === edge.target)?.type || ''
    ).toLowerCase())) || edges[0]
    : edges[0];
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
