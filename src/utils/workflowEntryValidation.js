const ENTRY_NODE_TYPES = new Set([
  'greeting',
  'audio',
  'availability_check',
  'slot_offer',
  'booking_confirm'
]);

export function hasWorkflowEntryNode(nodes) {
  return Array.isArray(nodes) && nodes.some((node) =>
    ENTRY_NODE_TYPES.has(String(node?.type || '').trim().toLowerCase())
  );
}

export function createMissingWorkflowEntryError() {
  return new Error('Workflow must have at least one greeting, audio, or booking entry node to be activated');
}
