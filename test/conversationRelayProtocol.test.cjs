const { test } = require('node:test');
const assert = require('node:assert/strict');

const importProtocol = () => import('../src/services/conversationRelayProtocol.js');
const importAIUrl = () => import('../src/config/conversationAIUrl.js');

test('partial speech is acknowledged diagnostically but not sent to AI', async () => {
  const { processRelayPrompt } = await importProtocol();
  let aiCalls = 0;
  const stages = [];
  const result = await processRelayPrompt({
    message: { type: 'prompt', voicePrompt: 'incomplete', last: false, lang: 'ta-IN' },
    callSid: 'CA-test', requestAI: async () => { aiCalls += 1; }, send: () => true,
    onStage: (stage) => stages.push(stage)
  });
  assert.equal(result.status, 'partial');
  assert.equal(aiCalls, 0);
  assert.deepEqual(stages, ['prompt_partial']);
});

test('final speech is sent to AI and response uses ConversationRelay text token fields', async () => {
  const { processRelayPrompt } = await importProtocol();
  let receivedText = '';
  const outgoing = [];
  const stages = [];
  const result = await processRelayPrompt({
    message: { type: 'prompt', voicePrompt: 'வணக்கம்', last: true, lang: 'ta-IN' },
    callSid: 'CA-test',
    requestAI: async (text, message) => {
      receivedText = `${text}:${message.lang}`;
      return { success: true, response: 'Vanakkam', intent: 'continue' };
    },
    send: (message) => { outgoing.push(message); return true; },
    onStage: (stage) => stages.push(stage)
  });
  assert.equal(result.status, 'spoken');
  assert.equal(receivedText, 'வணக்கம்:ta-IN');
  assert.deepEqual(outgoing, [{ type: 'text', token: 'Vanakkam', last: true, interruptible: true }]);
  assert.ok(stages.includes('speech_received'));
  assert.ok(stages.includes('response_sent'));
});

test('AI failure sends spoken recovery and leaves a subsequent turn processable', async () => {
  const { processRelayPrompt } = await importProtocol();
  const outgoing = [];
  const stages = [];
  const failure = await processRelayPrompt({
    message: { type: 'prompt', voicePrompt: 'question', last: true }, callSid: 'CA-test',
    requestAI: async () => { const error = new Error('private provider detail'); error.response = { status: 503 }; throw error; },
    send: (message) => { outgoing.push(message); return true; },
    onStage: (stage, fields) => stages.push([stage, fields])
  });
  const recovery = await processRelayPrompt({
    message: { type: 'prompt', voicePrompt: 'retry', last: true }, callSid: 'CA-test',
    requestAI: async () => ({ response: 'Recovered', intent: 'continue' }),
    send: (message) => { outgoing.push(message); return true; }
  });
  assert.equal(failure.status, 'failed');
  assert.equal(recovery.status, 'spoken');
  assert.equal(outgoing[0].type, 'text');
  assert.equal(outgoing[0].last, true);
  assert.match(outgoing[0].token, /trouble right now/);
  assert.equal(outgoing[1].token, 'Recovered');
  assert.equal(stages.at(-1)[0], 'ai_turn_failed');
  assert.equal(stages.at(-1)[1].status, 503);
});

test('interrupt invalidates an AI response that finishes late', async () => {
  const { processRelayPrompt } = await importProtocol();
  const outgoing = [];
  const result = await processRelayPrompt({
    message: { type: 'prompt', voicePrompt: 'question', last: true }, callSid: 'CA-test',
    isCurrent: () => false,
    requestAI: async () => ({ response: 'Should not be played', intent: 'continue' }),
    send: (message) => { outgoing.push(message); return true; }
  });
  assert.equal(result.status, 'stale');
  assert.deepEqual(outgoing, []);
});

test('human handoff returns control using the ConversationRelay end message', async () => {
  const { processRelayPrompt } = await importProtocol();
  const outgoing = [];
  const result = await processRelayPrompt({
    message: { type: 'prompt', voicePrompt: 'human please', last: true }, callSid: 'CA-test',
    requestAI: async () => ({ response: 'Connecting you now', intent: 'human_transfer' }),
    shouldTransfer: () => true,
    send: (message) => { outgoing.push(message); return true; }
  });
  assert.equal(result.status, 'transfer');
  assert.equal(outgoing[0].type, 'end');
  assert.deepEqual(JSON.parse(outgoing[0].handoffData), { status: 'transfer', intent: 'human_transfer' });
});

test('Python AI endpoint resolution uses the service URL configured for Render', async () => {
  const { resolveConversationAIBaseUrl } = await importAIUrl();
  assert.equal(resolveConversationAIBaseUrl({ NODE_ENV: 'production', PYTHON_TTS_BASE_URL: 'https://python.example.test/' }), 'https://python.example.test');
  assert.equal(resolveConversationAIBaseUrl({ NODE_ENV: 'production', AI_SERVICE_HTTP: 'https://ai.example.test', PYTHON_TTS_BASE_URL: 'https://python.example.test' }), 'https://ai.example.test');
  assert.equal(resolveConversationAIBaseUrl({ NODE_ENV: 'production', AI_SERVICE_HTTP: 'http://localhost:4000', PYTHON_TTS_BASE_URL: 'https://python.example.test' }), 'https://python.example.test');
  assert.throws(() => resolveConversationAIBaseUrl({ NODE_ENV: 'production' }), /must point to the Python AI service/);
  assert.throws(() => resolveConversationAIBaseUrl({ NODE_ENV: 'production', AI_SERVICE_HTTP: 'http://localhost:4000' }), /publicly reachable/);
  assert.throws(() => resolveConversationAIBaseUrl({ NODE_ENV: 'production', AI_SERVICE_HTTP: 'https://user:pass@example.test' }), /without embedded credentials/);
});
