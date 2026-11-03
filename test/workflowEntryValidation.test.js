import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMissingWorkflowEntryError,
  hasWorkflowEntryNode
} from '../src/utils/workflowEntryValidation.js';

const frontendEntryTypes = {
  greeting: 'greeting',
  audio: 'audio',
  booking: 'availability_check'
};

for (const [label, type] of Object.entries(frontendEntryTypes)) {
  test(`activates a workflow with a valid ${label} entry node`, () => {
    assert.equal(hasWorkflowEntryNode([{ id: 'entry-1', type }]), true);
  });
}

test('rejects activation when there is no valid entry node, including an empty workflow', () => {
  for (const nodes of [[], [{ type: 'input' }], [{ type: 'ai_voice_agent' }], null]) {
    if (hasWorkflowEntryNode(nodes)) continue;
    assert.throws(() => {
      throw createMissingWorkflowEntryError();
    }, /at least one greeting, audio, or booking entry node/);
  }
});

test('matches frontend booking type identifiers exactly and tolerates legacy case/whitespace', () => {
  for (const type of ['availability_check', 'slot_offer', 'booking_confirm']) {
    assert.equal(hasWorkflowEntryNode([{ type }]), true);
  }
  assert.equal(hasWorkflowEntryNode([{ type: ' Availability_Check ' }]), true);
});

test('does not promote AI Voice Agent or other arbitrary nodes to entry nodes', () => {
  assert.equal(hasWorkflowEntryNode([{ type: 'ai_voice_agent' }]), false);
  assert.equal(hasWorkflowEntryNode([{ type: 'booking_create' }]), false);
  // The unused legacy realtime builder still contains this type, but the
  // active backend has no matching execution node for it.
  assert.equal(hasWorkflowEntryNode([{ type: 'booking_service' }]), false);
});
