const { test } = require('node:test');
const assert = require('node:assert/strict');
const hasTwilioDependency = (() => { try { require.resolve('twilio'); return true; } catch { return false; } })();

const importRelay = () => import('../src/config/conversationRelay.js');

const baseConfig = {
  companyName: 'Nexion',
  welcomeMessage: 'Vanakkam. How can I help?',
  systemPrompt: 'Be concise and helpful.',
  knowledgeBase: 'Hours: 9 to 5.',
  discountQuestion: 'Would you like to hear about our current offers?',
  language: 'ta-IN',
  voiceSelection: 'ZhJ5LanYnCmLKQUXvsV7',
  humanAgentPhoneNumber: '+14155550123',
  transferOnCustomerRequest: true,
  transferOnDiscountInterest: true,
  maxDuration: 300,
  silenceTimeout: 2
};

test('AI voice agent accepts configured Tamil voice and rejects language mismatch', async () => {
  const { validateAgentConfig } = await importRelay();
  assert.equal(validateAgentConfig(baseConfig), true);
  assert.throws(() => validateAgentConfig({ ...baseConfig, language: 'en-IN' }), /does not match/);
});

test('human transfer requires a valid configured E.164 destination', async () => {
  const { validateAgentConfig } = await importRelay();
  assert.throws(() => validateAgentConfig({ ...baseConfig, humanAgentPhoneNumber: '' }), /human agent number/);
  assert.equal(validateAgentConfig({ ...baseConfig, humanAgentPhoneNumber: '', transferOnCustomerRequest: false, transferOnDiscountInterest: false }), true);
});

test('workflow node emits ConversationRelay TwiML with language, voice and callback path', { skip: !hasTwilioDependency }, async () => {
  process.env.PUBLIC_WEBHOOK_BASE_URL = 'https://nexion.example.test';
  const { default: engine } = await import('../src/services/ivrExecutionEngine.js');
  const xml = await engine.executeNode(
    { id: 'agent1', type: 'ai_voice_agent', data: baseConfig },
    { callSid: 'CA123', variables: {} },
    { _id: 'wf123', createdBy: 'user123', nodes: [], edges: [], settings: {} },
    'CA123'
  );
  assert.match(xml, /<ConversationRelay/);
  assert.match(xml, /wss:\/\/nexion\.example\.test\/ws\/conversation-relay/);
  assert.match(xml, /ZhJ5LanYnCmLKQUXvsV7/);
  assert.match(xml, /language="ta-IN"/);
  assert.match(xml, /speechTimeout="2000"/);
  assert.match(xml, /\/webhook\/twilio\/ai-voice-agent\/complete/);
});

test('invalid voice does not silently generate English agent TwiML', { skip: !hasTwilioDependency }, async () => {
  process.env.PUBLIC_WEBHOOK_BASE_URL = 'https://nexion.example.test';
  const { default: engine } = await import('../src/services/ivrExecutionEngine.js');
  const xml = await engine.executeNode(
    { id: 'agent1', type: 'ai_voice_agent', data: { ...baseConfig, voiceSelection: 'invalid' } },
    { callSid: 'CA123' },
    { _id: 'wf123', createdBy: 'user123', nodes: [], edges: [], settings: {} },
    'CA123'
  );
  assert.doesNotMatch(xml, /<ConversationRelay/);
  assert.match(xml, /currently unavailable/);
});
