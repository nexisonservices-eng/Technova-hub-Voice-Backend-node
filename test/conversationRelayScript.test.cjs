const { test } = require('node:test');
const assert = require('node:assert/strict');

const importScript = () => import('../src/services/conversationRelayScript.js');

test('script playback contains the four fixed sections in order and listens after the final section', async () => {
  const { SCRIPT_SECTIONS, SCRIPT_MESSAGES, createScriptState, startScript } = await importScript();
  const state = createScriptState();
  const result = startScript(state);

  assert.equal(result.status, 'started');
  assert.deepEqual(result.messages.map((message) => message.token), SCRIPT_SECTIONS.map(({ text }) => text));
  assert.deepEqual(result.messages.map(({ last }) => last), [false, false, false, true]);
  assert.ok(result.messages.every(({ interruptible, preemptible }) => !interruptible && !preemptible));
  assert.deepEqual(result.messages, SCRIPT_MESSAGES);
  assert.equal(state.stage, 'awaiting_answer');
  assert.equal(startScript(state).status, 'ignored');
});

test('yes response enters same-call human transfer when configured', async () => {
  const { createScriptState, handleScriptReply, buildScriptHandoffActions, SCRIPT_RESPONSES } = await importScript();
  const state = createScriptState();
  state.stage = 'awaiting_answer';
  const result = handleScriptReply(state, 'Yes, I am interested', { transferAvailable: true });
  assert.equal(result.status, 'transfer');
  assert.equal(state.stage, 'transferring');
  assert.deepEqual(result.handoff, {
    status: 'transfer', intent: 'human_transfer', scriptVoiceAgent: true
  });
  assert.deepEqual(buildScriptHandoffActions(result.handoff, {
    transferOnCustomerRequest: true, humanAgentPhoneNumber: '+14155550123'
  }), [
    { type: 'say', text: SCRIPT_RESPONSES.transfer },
    { type: 'dial', destination: '+14155550123' }
  ]);
});

test('Tamil, English and Tanglish yes/no responses are deterministic', async () => {
  const { classifyScriptReply } = await importScript();
  for (const reply of ['yes', 'interested', 'okay', 'sure', 'ஆமாம்', 'சரி', 'venum']) {
    assert.equal(classifyScriptReply(reply), 'yes', reply);
  }
  for (const reply of ['no', 'not interested', 'வேண்டாம்', 'illa', 'vendam']) {
    assert.equal(classifyScriptReply(reply), 'no', reply);
  }
});

test('no response returns the graceful termination handoff', async () => {
  const { createScriptState, handleScriptReply, buildScriptHandoffActions, SCRIPT_RESPONSES } = await importScript();
  const state = createScriptState();
  state.stage = 'awaiting_answer';
  const result = handleScriptReply(state, 'No, thank you', { transferAvailable: true });
  assert.equal(result.status, 'end');
  assert.deepEqual(result.handoff, { status: 'script_decline' });
  assert.deepEqual(buildScriptHandoffActions(result.handoff), [
    { type: 'say', text: SCRIPT_RESPONSES.decline }, { type: 'hangup' }
  ]);
  assert.equal(state.stage, 'ending');
});

test('unclear response asks the fixed clarification and continues listening', async () => {
  const { createScriptState, handleScriptReply, SCRIPT_RESPONSES } = await importScript();
  const state = createScriptState();
  state.stage = 'awaiting_answer';
  const result = handleScriptReply(state, 'maybe later', { transferAvailable: true });
  assert.equal(result.status, 'clarify');
  assert.equal(result.token, SCRIPT_RESPONSES.unclear);
  assert.equal(state.stage, 'awaiting_answer');
});

test('yes does not claim success when representative transfer is unavailable', async () => {
  const { createScriptState, handleScriptReply, buildScriptHandoffActions, SCRIPT_RESPONSES } = await importScript();
  const state = createScriptState();
  state.stage = 'awaiting_answer';
  const result = handleScriptReply(state, 'sure', { transferAvailable: false });
  assert.equal(result.status, 'end');
  assert.deepEqual(result.handoff, { status: 'script_unavailable' });
  assert.deepEqual(buildScriptHandoffActions(result.handoff), [
    { type: 'say', text: SCRIPT_RESPONSES.unavailable }, { type: 'hangup' }
  ]);
  assert.equal(state.stage, 'ending');
});

test('reply handling is closed after termination begins', async () => {
  const { createScriptState, handleScriptReply } = await importScript();
  const state = createScriptState();
  state.stage = 'ending';
  assert.deepEqual(handleScriptReply(state, 'yes', { transferAvailable: true }), { status: 'ignored' });
});
