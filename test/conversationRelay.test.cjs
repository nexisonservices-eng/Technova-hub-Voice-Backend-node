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

const assertWellFormedXml = (xml) => {
  const stack = [];
  const tags = [...xml.matchAll(/<\/?([A-Za-z][\w.-]*)(?:\s[^<>]*?)?\s*\/?>/g)];
  for (const [tag, name] of tags) {
    if (/^<\?/.test(tag) || /^<!/.test(tag)) continue;
    if (/^<\//.test(tag)) {
      assert.equal(stack.pop(), name, `Mismatched closing tag ${tag}`);
    } else if (!/\/>$/.test(tag)) {
      stack.push(name);
    }
  }
  assert.equal(stack.length, 0, 'XML elements should be balanced');
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
    { _id: 'wf123', createdBy: 'user123', provider: 'twilio', nodes: [], edges: [], settings: {} },
    'CA123'
  );
  assertWellFormedXml(xml);
  assert.match(xml, /<Connect action="https:\/\/nexion\.example\.test\/webhook\/twilio\/ai-voice-agent\/complete\?userId=user123&amp;workflowId=wf123&amp;nodeId=agent1" method="POST">/);
  assert.match(xml, /<ConversationRelay/);
  assert.match(xml, /wss:\/\/nexion\.example\.test\/ws\/conversation-relay/);
  assert.match(xml, /ZhJ5LanYnCmLKQUXvsV7/);
  assert.match(xml, /language="ta-IN"/);
  assert.match(xml, /speechTimeout="2000"/);
  assert.match(xml, /welcomeGreeting="வணக்கம்! TechnovaHub-க்கு வெல்கம்\. நான் உங்களோட AI ஹெல்ப்பர்\. உங்களுக்கு எப்படி ஹெல்ப் பண்ணலாம்\?"/);
  assert.match(xml, /welcomeGreetingInterruptible="none"/);
  assert.match(xml, /transcriptionLanguage="multi"/);
  assert.match(xml, /transcriptionProvider="Deepgram"/);
  assert.match(xml, /reportInputDuringAgentSpeech="none"/);
  assert.match(xml, /\/webhook\/twilio\/ai-voice-agent\/complete/);
});

test('ConversationRelay XML escapes dynamic attributes and requires secure WebSocket URLs', async () => {
  const { buildConversationRelayTwiML } = await import('../src/config/conversationRelay.js');
  const xml = buildConversationRelayTwiML({
    url: 'wss://nexion.example.test/relay?a=1&b=2', action: 'https://nexion.example.test/callback?x=1&y=2',
    welcomeGreeting: 'Hello "A&B" <caller>', language: 'en-US', voice: 'voice&name'
  });
  assertWellFormedXml(xml);
  assert.match(xml, /url="wss:\/\/nexion\.example\.test\/relay\?a=1&amp;b=2"/);
  assert.match(xml, /welcomeGreeting="Hello &quot;A&amp;B&quot; &lt;caller&gt;"/);
  assert.throws(() => buildConversationRelayTwiML({ url: 'ws://insecure.test', action: '/callback' }), /secure wss/);
});

test('ConversationRelay supports multilingual STT while preserving the configured TTS voice', async () => {
  const { buildConversationRelayTwiML } = await import('../src/config/conversationRelay.js');
  const { FAQ_WELCOME } = await import('../src/services/conversationRelayFaq.js');
  const xml = buildConversationRelayTwiML({
    url: 'wss://nexion.example.test/relay', action: 'https://nexion.example.test/complete',
    language: 'ta-IN', voice: 'ZhJ5LanYnCmLKQUXvsV7',
    ttsProvider: 'ElevenLabs', transcriptionProvider: 'Deepgram',
    transcriptionLanguage: 'multi', reportInputDuringAgentSpeech: 'none',
    welcomeGreeting: FAQ_WELCOME, welcomeGreetingInterruptible: 'none'
  });
  assert.match(xml, /welcomeGreeting="வணக்கம்! TechnovaHub-க்கு வெல்கம்\. நான் உங்களோட AI ஹெல்ப்பர்\. உங்களுக்கு எப்படி ஹெல்ப் பண்ணலாம்\?"/);
  assert.match(xml, /welcomeGreetingInterruptible="none"/);
  assert.match(xml, /voice="ZhJ5LanYnCmLKQUXvsV7"/);
  assert.match(xml, /ttsProvider="ElevenLabs"/);
  assert.match(xml, /transcriptionProvider="Deepgram"/);
  assert.match(xml, /transcriptionLanguage="multi"/);
  assert.match(xml, /reportInputDuringAgentSpeech="none"/);
});

test('call provider selection uses persisted provider fields and defaults safely to unsupported', async () => {
  const { resolveCallProvider } = await import('../src/config/conversationRelay.js');
  assert.equal(resolveCallProvider({ provider: 'TwIlIo', providerData: { provider: 'exotel' } }), 'twilio');
  assert.equal(resolveCallProvider({ providerData: { provider: 'Exotel' } }), 'exotel');
  assert.equal(resolveCallProvider({}), '');
});

test('unsupported call providers receive controlled speech and hangup TwiML', async () => {
  const { buildUnsupportedProviderTwiML } = await import('../src/config/conversationRelay.js');
  const xml = buildUnsupportedProviderTwiML();
  assertWellFormedXml(xml);
  assert.match(xml, /<Say>The voice assistant is unavailable for this call provider\./);
  assert.match(xml, /<Hangup\/>/);
  assert.doesNotMatch(xml, /<ConversationRelay/);
});

test('AI Voice Agent rejects non-Twilio provider without emitting ConversationRelay', { skip: !hasTwilioDependency }, async () => {
  const { default: engine } = await import('../src/services/ivrExecutionEngine.js');
  const xml = await engine.executeNode(
    { id: 'agent1', type: 'ai_voice_agent', data: baseConfig },
    { callSid: 'EX123' },
    { _id: 'wf123', createdBy: 'user123', provider: 'exotel', nodes: [], edges: [], settings: {} },
    'EX123'
  );
  assert.doesNotMatch(xml, /<ConversationRelay/);
  assert.match(xml, /unavailable for this call provider/);
});

test('invalid voice does not silently generate English agent TwiML', { skip: !hasTwilioDependency }, async () => {
  process.env.PUBLIC_WEBHOOK_BASE_URL = 'https://nexion.example.test';
  const { default: engine } = await import('../src/services/ivrExecutionEngine.js');
  const xml = await engine.executeNode(
    { id: 'agent1', type: 'ai_voice_agent', data: { ...baseConfig, voiceSelection: 'invalid' } },
    { callSid: 'CA123' },
    { _id: 'wf123', createdBy: 'user123', provider: 'twilio', nodes: [], edges: [], settings: {} },
    'CA123'
  );
  assert.doesNotMatch(xml, /<ConversationRelay/);
  assert.match(xml, /currently unavailable/);
});
