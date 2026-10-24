const { test } = require('node:test');
const assert = require('node:assert/strict');

const importSession = () => import('../src/services/conversationRelaySession.js');
const importProtocol = () => import('../src/services/conversationRelayProtocol.js');

const callSid = 'CA0123456789abcdef0123456789abcdef';
const otherCallSid = 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const owner = '64b000000000000000000001';
const workflowId = '64b000000000000000000002';
const nodeId = 'agent-node';
const makeExecution = (overrides = {}) => ({ callSid, userId: owner, workflowId, ...overrides });
const makeCall = (overrides = {}) => ({
  callSid, user: owner, provider: 'twilio', providerData: { workflowId }, ...overrides
});

test('setup then Tamil prompt reaches mocked Python and produces a spoken Relay text token', async () => {
  const { bindRelaySetupCallSid, createRelaySessionContext, getRelaySessionCallSid } = await importSession();
  const { createOrderedRelayFrameQueue, processRelayPrompt } = await importProtocol();
  const session = createRelaySessionContext({ userId: owner, workflowId, nodeId });
  const outgoing = [];
  const pythonRequests = [];
  const setupResult = [];

  const queue = createOrderedRelayFrameQueue(async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'setup') {
      setupResult.push(bindRelaySetupCallSid(session, message, {
        execution: makeExecution(), call: makeCall()
      }));
      return;
    }
    await processRelayPrompt({
      message,
      callSid: getRelaySessionCallSid(session),
      requestAI: async (text) => {
        pythonRequests.push({ text, call_id: getRelaySessionCallSid(session) });
        return { success: true, response: 'வணக்கம்! எப்படி உதவலாம்?', intent: 'continue' };
      },
      send: (payload) => { outgoing.push(payload); return true; }
    });
  });

  // Twilio can send setup before authorization finishes and the listener's queue is activated.
  queue.enqueue(Buffer.from(JSON.stringify({ type: 'setup', callSid, sessionId: 'VX-test' })));
  queue.enqueue(Buffer.from(JSON.stringify({
    type: 'prompt', voicePrompt: 'வணக்கம்', lang: 'ta-IN', last: true,
    callSid: otherCallSid // A prompt field cannot override the setup-bound call identity.
  })));
  await queue.activate();

  assert.deepEqual(setupResult, [{ valid: true, callSid }]);
  assert.deepEqual(pythonRequests, [{ text: 'வணக்கம்', call_id: callSid }]);
  assert.deepEqual(outgoing, [{ type: 'text', token: 'வணக்கம்! எப்படி உதவலாம்?', last: true, interruptible: true }]);
});

test('three consecutive prompts in one authenticated call each reach Python and can transfer on the third turn', async () => {
  const { bindRelaySetupCallSid, createRelaySessionContext, getRelaySessionCallSid } = await importSession();
  const { createOrderedRelayFrameQueue, processRelayPrompt } = await importProtocol();
  const session = createRelaySessionContext({ userId: owner, workflowId, nodeId });
  const questions = [
    'What services does TechnovaHub provide?',
    'What is Nexion?',
    'Do you have any discounts?'
  ];
  const answers = ['TechnovaHub provides technology services.', 'Nexion automates business workflows.', 'I can connect you with a representative.'];
  const results = [
    { success: true, response: answers[0], intent: 'continue' },
    { success: true, response: answers[1], intent: 'continue' },
    { success: true, response: answers[2], intent: 'discount_yes' }
  ];
  const pythonRequests = [];
  const outgoing = [];
  let turnIndex = 0;
  const queue = createOrderedRelayFrameQueue(async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'setup') {
      bindRelaySetupCallSid(session, message, { execution: makeExecution(), call: makeCall() });
      return;
    }
    const result = results[turnIndex++];
    await processRelayPrompt({
      message, callSid: getRelaySessionCallSid(session),
      requestAI: async (text) => { pythonRequests.push(text); return result; },
      shouldTransfer: (aiResult) => aiResult.intent === 'discount_yes',
      send: (payload) => { outgoing.push(payload); return true; }
    });
  });
  queue.enqueue(Buffer.from(JSON.stringify({ type: 'setup', callSid })));
  for (const voicePrompt of questions) {
    queue.enqueue(Buffer.from(JSON.stringify({ type: 'prompt', voicePrompt, lang: 'en-IN', last: true })));
  }
  await queue.activate();

  assert.deepEqual(pythonRequests, questions);
  assert.deepEqual(outgoing.slice(0, 2), answers.slice(0, 2).map((token) => ({
    type: 'text', token, last: true, interruptible: true
  })));
  assert.equal(outgoing[2].type, 'end');
  assert.deepEqual(JSON.parse(outgoing[2].handoffData), { status: 'transfer', intent: 'discount_yes' });
});

test('prompt without setup is rejected and never calls Python', async () => {
  const { createRelaySessionContext, getRelaySessionCallSid } = await importSession();
  const { processRelayPrompt } = await importProtocol();
  const session = createRelaySessionContext({ userId: owner, workflowId, nodeId });
  let aiCalls = 0;
  const stages = [];
  const result = await processRelayPrompt({
    message: { type: 'prompt', voicePrompt: 'hello', last: true, callSid },
    callSid: getRelaySessionCallSid(session),
    requestAI: async () => { aiCalls += 1; return { response: 'No' }; },
    send: () => true,
    onStage: (stage, fields) => stages.push([stage, fields])
  });
  assert.equal(result.status, 'invalid');
  assert.equal(aiCalls, 0);
  assert.equal(stages[0][1].reason, 'missing_setup');
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

test('wrong call provider and malformed setup/prompt events fail closed with safe reasons', async () => {
  const { bindRelaySetupCallSid, createRelaySessionContext } = await importSession();
  const { processRelayPrompt } = await importProtocol();
  const session = createRelaySessionContext({ userId: owner, workflowId, nodeId });
  assert.equal(bindRelaySetupCallSid(session, { type: 'setup', callSid: 'not-a-call-sid' }, { execution: makeExecution() }).reason, 'malformed_call_sid');
  assert.equal(bindRelaySetupCallSid(session, { type: 'setup', callSid }, {
    execution: makeExecution(), call: makeCall({ provider: 'exotel' })
  }).reason, 'wrong_provider');

  const stages = [];
  const malformed = await processRelayPrompt({
    message: { type: 'prompt', voicePrompt: { unexpected: true }, last: true },
    callSid,
    requestAI: async () => assert.fail('Malformed prompt must not reach Python'),
    send: () => true,
    onStage: (stage, fields) => stages.push([stage, fields])
  });
  assert.equal(malformed.status, 'invalid');
  assert.equal(stages[0][1].reason, 'missing_text');
  assert.equal(JSON.stringify(stages).includes('unexpected'), false);
});

test('callback call-owner association requires the expected tenant and workflow', async () => {
  const { resolveCallOwnerFromRecords } = await importSession();
  const result = resolveCallOwnerFromRecords({
    callSid,
    tenantUserId: owner,
    queryUserId: '64b000000000000000000009',
    workflowId,
    call: makeCall(),
    execution: makeExecution()
  });
  assert.deepEqual(result, { valid: false, reason: 'wrong_tenant' });
  const wrongWorkflow = resolveCallOwnerFromRecords({
    callSid, tenantUserId: owner, queryUserId: owner,
    workflowId: '64b000000000000000000009', call: makeCall(), execution: makeExecution()
  });
  assert.deepEqual(wrongWorkflow, { valid: false, reason: 'wrong_workflow' });
});
