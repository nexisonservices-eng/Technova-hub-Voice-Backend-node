const { test } = require('node:test');
const assert = require('node:assert/strict');

const importFaq = () => import('../src/services/conversationRelayFaq.js');
const importTransfer = () => import('../src/services/conversationRelayTransfer.js');

const customerA = '+14155550111';
const teamB = '+14155550222';

const makeWorkflow = (destination = teamB) => ({
  nodes: [
    { id: 'voice-agent', type: 'ai_voice_agent', data: { humanAgentPhoneNumber: customerA } },
    { id: 'team-handoff', type: 'handoff', data: { destination } },
    { id: 'after-handoff', type: 'end', data: {} }
  ],
  edges: [
    { source: 'voice-agent', sourceHandle: 'transferred', target: 'team-handoff' },
    { source: 'team-handoff', sourceHandle: 'connected', target: 'after-handoff' }
  ]
});

test('inbound and outbound AI Voice Agent transfers dial the connected Hand Off destination, never the customer', async () => {
  const { buildFaqHandoffActions } = await importFaq();
  const { resolveAIVoiceTransferContinuation, resolveConnectedHandoffDestination } = await importTransfer();
  const workflow = makeWorkflow();

  for (const direction of ['inbound', 'outbound']) {
    const callContext = direction === 'outbound'
      ? { direction, to: customerA, destinationNumber: customerA }
      : { direction, from: customerA };
    const resolution = resolveConnectedHandoffDestination(workflow, 'voice-agent');
    assert.deepEqual(resolution, { destination: teamB, handoffNodeId: 'team-handoff', reason: '' });
    const actions = buildFaqHandoffActions({ status: 'faq_transfer', faqId: 'ai_automation' }, {
      ...workflow.nodes[0].data,
      humanAgentPhoneNumber: resolution.destination,
      transferOnCustomerRequest: true
    });
    assert.deepEqual(actions, [{ type: 'dial', destination: teamB }], direction);
    assert.notEqual(actions.find(({ type }) => type === 'dial')?.destination, callContext.to || callContext.from);
    assert.equal(resolveAIVoiceTransferContinuation(workflow, 'voice-agent', true), 'after-handoff');
  }
});

test('missing or invalid connected Hand Off destination fails closed without dialing AI node or customer numbers', async () => {
  const { buildFaqHandoffActions } = await importFaq();
  const { resolveConnectedHandoffDestination } = await importTransfer();
  for (const configured of ['', '4155550222']) {
    const workflow = makeWorkflow(configured);
    const resolved = resolveConnectedHandoffDestination(workflow, 'voice-agent');
    assert.equal(resolved.destination, '');
    const actions = buildFaqHandoffActions({ status: 'faq_transfer', faqId: 'ai_automation' }, {
      ...workflow.nodes[0].data,
      humanAgentPhoneNumber: resolved.destination,
      transferOnCustomerRequest: true
    });
    assert.deepEqual(actions.map(({ type }) => type), ['say', 'hangup']);
    assert.equal(actions.some(({ type, destination }) => type === 'dial' && [customerA, teamB].includes(destination)), false);
  }
});

test('a missing transferred edge never falls back to the AI node humanAgentPhoneNumber', async () => {
  const { resolveConnectedHandoffDestination } = await importTransfer();
  const workflow = makeWorkflow();
  workflow.edges = [];
  const result = resolveConnectedHandoffDestination(workflow, 'voice-agent');
  assert.deepEqual(result, { destination: '', handoffNodeId: '', reason: 'transferred_edge_missing' });
});
