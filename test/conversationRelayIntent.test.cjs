const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/services/conversationRelayIntent.js');

test('multilingual intent corpus preserves configured answers and rejects near words', async () => {
  const { recognizeMultilingualIntent: recognize } = await load();
  const { FAQ_ENTRIES } = await import('../src/services/conversationRelayFaq.js');
  const corpus = [
    ['services', ['What services do you provide?', 'Enna services pandringa?',
      'என்ன சர்வீசஸ் பண்றீங்க?', 'என்ன சேவைகள் செய்கிறீர்கள்?', 'என்ன services பண்றீங்க?',
      'Yeah, what services do you provide?', 'What services do you provde?']],
    ['ai_automation', ['What is AI automation?', 'AI automation na enna?',
      'ஏஐ ஆட்டோமேஷன் என்றால் என்ன?', 'AI ஆட்டோமேஷன் என்ன?', 'Yeah, automationальна.',
      'Please explain AI automation', 'Tell me about AI automation']]
  ];
  for (const [id, questions] of corpus) for (const question of questions) {
    const result = recognize(question);
    assert.equal(result.faq?.id, id, question);
    assert.equal(result.faq.answer, FAQ_ENTRIES.find((entry) => entry.id === id).answer);
    assert.ok(result.confidence >= 0.9);
    assert.ok(result.latencyMs >= 0);
  }
  for (const text of ['what servants do you provide', 'what servers do you provide',
    'what severance do you provide', 'automationish', 'what is payroll automation',
    'Yeah can you explain my mortgage', 'AI automation and services pricing comparison',
    'unlisted question', '', '...']) assert.equal(recognize(text).faq, null, text);
  assert.equal(recognize('contact number').faq.id, 'contact');
  assert.equal(recognize('what services do you provde').reason, 'bounded_phrase_similarity');
});

test('flag is explicit; errors use existing matcher and safe diagnostics omit customer prose', async () => {
  const { multilingualIntentEnabled: enabled, resolveConversationRelayIntent: resolve,
    recognizeMultilingualIntent: recognize, intentDiagnostic, detectTranscriptLanguage } = await load();
  const { matchFaq } = await import('../src/services/conversationRelayFaq.js');
  for (const value of [undefined, 'false', '1', 'TRUE']) assert.equal(enabled({ CONVERSATION_RELAY_MULTILINGUAL_NLP: value }), false);
  assert.equal(enabled({ CONVERSATION_RELAY_MULTILINGUAL_NLP: 'true' }), true);
  assert.equal(resolve('what services', { enabled: false }).faq, matchFaq('what services'));
  const failed = resolve('what services', { enabled: true, recognizer: () => { throw Error('secret'); } });
  assert.equal(failed.faq.id, 'services');
  assert.equal(failed.fallbackReason, 'recognizer_error');
  const safe = JSON.stringify(intentDiagnostic(recognize('my name is Kavitha email a@b.com password abc123 9876543210')));
  for (const privateText of ['kavitha', 'a@b', 'abc123', '9876543210']) assert.equal(safe.includes(privateText), false);
  assert.equal(detectTranscriptLanguage('என்ன சேவைகள்'), 'ta');
  assert.equal(detectTranscriptLanguage('என்ன services'), 'mixed-ta-latin');
  assert.equal(detectTranscriptLanguage('enna services'), 'tanglish');
});

test('optional intent matcher keeps repeated questions and standalone confirmations safe', async () => {
  const { recognizeMultilingualIntent: recognize } = await load();
  const { createFaqState, processLiveConversationRelayFaqTurn } = await import('../src/services/conversationRelayFaq.js');
  for (const offer of ['unlisted question', 'AI automation na enna?']) {
    const state = createFaqState();
    const frames = [];
    const turn = (text) => processLiveConversationRelayFaqTurn(state, text, {
      transferAvailable: true, matcher: (value) => recognize(value).faq,
      strictConfirmation: true, send: (frame) => { frames.push(frame); return true; }
    });
    turn(offer);
    assert.equal(turn('Yeah, can you explain my mortgage').action, 'answer');
    assert.equal(frames.some((frame) => frame.type === 'end'), false);
    for (let repeat = 0; repeat < 2; repeat++) assert.equal(turn('என்ன சேவைகள் செய்கிறீர்கள்?').faqId, 'services');
    turn('AI automation na enna?');
    assert.equal(turn('No').faqId, 'declined_automation_transfer');
    turn('AI automation na enna?');
    assert.equal(turn('Yeah, AI automation na enna?').action, 'answer');
    assert.equal(turn('Yes please').action, 'transfer');
    assert.equal(frames.filter((frame) => frame.type === 'end').length, 1);
    assert.equal(turn('Yes').action, 'ignored');
    assert.equal(frames.filter((frame) => frame.type === 'end').length, 1);
  }
});
