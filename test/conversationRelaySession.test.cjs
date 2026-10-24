const { test } = require('node:test');
const assert = require('node:assert/strict');

const importSession = () => import('../src/services/conversationRelaySession.js');
const importProtocol = () => import('../src/services/conversationRelayProtocol.js');
const importFaq = () => import('../src/services/conversationRelayFaq.js');

const callSid = 'CA0123456789abcdef0123456789abcdef';
const otherCallSid = 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const owner = '64b000000000000000000001';
const workflowId = '64b000000000000000000002';
const nodeId = 'agent-node';
const makeExecution = (overrides = {}) => ({ callSid, userId: owner, workflowId, ...overrides });
const makeCall = (overrides = {}) => ({
  callSid, user: owner, provider: 'twilio', providerData: { workflowId }, ...overrides
});

test('authenticated setup binds deterministic FAQ state to the Twilio call SID', async () => {
  const { bindRelaySetupCallSid, createRelaySessionContext, getRelaySessionCallSid } = await importSession();
  const { createOrderedRelayFrameQueue } = await importProtocol();
  const { createFaqState, processFaqPrompt } = await importFaq();
  const session = createRelaySessionContext({ userId: owner, workflowId, nodeId });
  const outgoing = [];
  let faqState = null;
  let setupResult;

  const queue = createOrderedRelayFrameQueue(async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'setup') {
      setupResult = bindRelaySetupCallSid(session, message, { execution: makeExecution(), call: makeCall() });
      if (setupResult.valid) faqState = createFaqState(setupResult.callSid);
      return;
    }
    assert.equal(getRelaySessionCallSid(session), callSid);
    assert.equal(faqState.callSid, callSid);
    const result = processFaqPrompt(faqState, message.voicePrompt, { transferAvailable: true });
    outgoing.push({ type: 'text', token: result.answer, last: true, interruptible: true });
  });

  queue.enqueue(Buffer.from(JSON.stringify({ type: 'setup', callSid, sessionId: 'VX-test' })));
  queue.enqueue(Buffer.from(JSON.stringify({
    type: 'prompt', voicePrompt: 'Nexion enna?', lang: 'ta-IN', last: true, callSid: otherCallSid
  })));
  await queue.activate();

  assert.deepEqual(setupResult, { valid: true, callSid });
  assert.deepEqual(outgoing, [{
    type: 'text',
    token: 'Nexion is a business automation solution developed by TechnovaHub. It helps businesses simplify workflows, automate repetitive tasks, and reduce manual work.',
    last: true, interruptible: true
  }]);
});

test('five consecutive prompts in one authenticated call each get an FAQ response', async () => {
  const { bindRelaySetupCallSid, createRelaySessionContext, getRelaySessionCallSid } = await importSession();
  const { createOrderedRelayFrameQueue } = await importProtocol();
  const { createFaqState, processFaqPrompt } = await importFaq();
  const session = createRelaySessionContext({ userId: owner, workflowId, nodeId });
  const questions = [
    'What is TechnovaHub?',
    'What services does TechnovaHub provide?',
    'What is Nexion?',
    'How does Nexion help businesses?',
    'Can Nexion automate repetitive tasks?'
  ];
  const outgoing = [];
  let faqState = null;
  const queue = createOrderedRelayFrameQueue(async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'setup') {
      const binding = bindRelaySetupCallSid(session, message, { execution: makeExecution(), call: makeCall() });
      if (binding.valid) faqState = createFaqState(binding.callSid);
      return;
    }
    assert.equal(getRelaySessionCallSid(session), callSid);
    const result = processFaqPrompt(faqState, message.voicePrompt, { transferAvailable: true });
    outgoing.push({ type: 'text', token: result.answer, last: true, interruptible: true });
  });

  queue.enqueue(Buffer.from(JSON.stringify({ type: 'setup', callSid })));
  for (const voicePrompt of questions) {
    queue.enqueue(Buffer.from(JSON.stringify({ type: 'prompt', voicePrompt, lang: 'en-IN', last: true })));
  }
  await queue.activate();

  assert.equal(faqState.callSid, callSid);
  assert.equal(faqState.turns, 5);
  assert.deepEqual(outgoing.map(({ token }) => token), [
    'TechnovaHub is a technology company that helps businesses improve their operations through IT services, intelligent automation, and digital transformation.',
    'TechnovaHub provides IT Services and Consulting, AI Automation, and Digital Transformation Solutions.',
    'Nexion is a business automation solution developed by TechnovaHub. It helps businesses simplify workflows, automate repetitive tasks, and reduce manual work.',
    'Nexion helps businesses save time, improve efficiency, connect important tools and processes, and focus on business growth.',
    'Yes. Nexion is designed to help businesses automate repetitive tasks and simplify everyday workflows.'
  ]);
});

test('prompt without authenticated setup cannot enter FAQ conversation', async () => {
  const { createRelaySessionContext, getRelaySessionCallSid } = await importSession();
  const session = createRelaySessionContext({ userId: owner, workflowId, nodeId });
  assert.equal(getRelaySessionCallSid(session), '');
});

test('invalid session and wrong-tenant setup identities are rejected', async () => {
  const { bindRelaySetupCallSid, createRelaySessionContext } = await importSession();
  const setup = { type: 'setup', callSid };
  assert.deepEqual(bindRelaySetupCallSid(null, setup, { execution: makeExecution() }), {
    valid: false, reason: 'invalid_session'
  });

  const session = createRelaySessionContext({ userId: owner, workflowId, nodeId });
  const wrongTenant = bindRelaySetupCallSid(session, setup, {
    execution: makeExecution({ userId: '64b000000000000000000009' }), call: makeCall()
  });
  assert.deepEqual(wrongTenant, { valid: false, reason: 'wrong_tenant' });
  assert.equal(session.callSid, '');
  assert.equal(bindRelaySetupCallSid(session, setup, {
    execution: makeExecution({ workflowId: '64b000000000000000000009' }), call: makeCall()
  }).reason, 'wrong_workflow');
});

test('wrong call provider and malformed setup identities fail closed', async () => {
  const { bindRelaySetupCallSid, createRelaySessionContext } = await importSession();
  const session = createRelaySessionContext({ userId: owner, workflowId, nodeId });
  assert.equal(bindRelaySetupCallSid(session, { type: 'setup', callSid: 'not-a-call-sid' }, { execution: makeExecution() }).reason, 'malformed_call_sid');
  assert.equal(bindRelaySetupCallSid(session, { type: 'setup', callSid }, {
    execution: makeExecution(), call: makeCall({ provider: 'exotel' })
  }).reason, 'wrong_provider');
});

test('callback call-owner association requires the expected tenant and workflow', async () => {
  const { resolveCallOwnerFromRecords } = await importSession();
  const result = resolveCallOwnerFromRecords({
    callSid, tenantUserId: owner, queryUserId: '64b000000000000000000009',
    workflowId, call: makeCall(), execution: makeExecution()
  });
  assert.deepEqual(result, { valid: false, reason: 'wrong_tenant' });
  const wrongWorkflow = resolveCallOwnerFromRecords({
    callSid, tenantUserId: owner, queryUserId: owner,
    workflowId: '64b000000000000000000009', call: makeCall(), execution: makeExecution()
  });
  assert.deepEqual(wrongWorkflow, { valid: false, reason: 'wrong_workflow' });
});
