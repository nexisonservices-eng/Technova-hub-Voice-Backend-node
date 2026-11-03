const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/services/conversationRelayGroq.js');
const enabledEnv = (extra = {}) => ({
  GROQ_NLP_ENABLED: 'true', GROQ_API_KEY: 'test-secret-key', ...extra
});
const completion = (content) => ({ data: { choices: [{ message: { content } }] } });

test('Groq is opt-in, requires a key, and never replaces a deterministic match', async () => {
  const { classifyUnmatchedQuestionWithGroq: classify } = await load();
  let calls = 0;
  const post = async () => { calls += 1; return completion('{"intent":"services","confidence":0.99}'); };

  assert.equal((await classify('unlisted question', {}, { env: { ...enabledEnv(), GROQ_NLP_ENABLED: 'false' }, post })).status, 'disabled');
  assert.equal((await classify('unlisted question', {}, { env: { GROQ_NLP_ENABLED: 'true' }, post })).status, 'missing_api_key');
  assert.equal((await classify('a question', { faq: { id: 'services' } }, { env: enabledEnv(), post })).status, 'deterministic_match');
  assert.equal((await classify('What is your pricing?', { reason: 'unsupported_pricing' }, { env: enabledEnv(), post })).status, 'deterministic_unsupported_topic');
  assert.equal((await classify('What is our pricing?', { reason: 'feature_disabled' }, { env: enabledEnv(), post })).status, 'non_faq_topic');
  assert.equal((await classify('latest cricket score', { reason: 'feature_disabled' }, { env: enabledEnv(), post })).status, 'non_faq_topic');
  assert.equal((await classify('Yes please', {}, { env: enabledEnv(), post })).status, 'standalone_confirmation');
  assert.equal(calls, 0);
});

test('Groq uses configurable JSON classification and returns only the configured FAQ entry', async () => {
  const { classifyUnmatchedQuestionWithGroq: classify } = await load();
  const { FAQ_ENTRIES } = await import('../src/services/conversationRelayFaq.js');
  let captured;
  const result = await classify('My name is Kavitha, could you tell me our services? Email me at person@example.com or call +1 415 555 0100', {}, {
    env: enabledEnv({ GROQ_NLP_MODEL: 'configured-test-model', GROQ_NLP_TIMEOUT_MS: '2500' }),
    post: async (...args) => {
      captured = args;
      return completion('{"intent":"services","confidence":0.93}');
    }
  });

  assert.equal(captured[0], 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(captured[1].model, 'configured-test-model');
  assert.deepEqual(captured[1].response_format, { type: 'json_object' });
  assert.equal(captured[1].temperature, 0);
  assert.equal(captured[1].stream, false);
  assert.equal(captured[2].timeout, 2500);
  assert.equal(captured[2].headers.Authorization, 'Bearer test-secret-key');
  const userMessage = captured[1].messages.find(({ role }) => role === 'user').content;
  assert.equal(userMessage.includes('Kavitha'), false);
  assert.equal(userMessage.includes('person@example.com'), false);
  assert.equal(userMessage.includes('415 555 0100'), false);
  assert.deepEqual(result, {
    attempted: true, faq: FAQ_ENTRIES.find(({ id }) => id === 'services'),
    intent: 'services', confidence: 0.93, model: 'configured-test-model',
    failureKind: null, status: 'classified'
  });

  const automation = await classify('AI automation meaning enna?', {}, {
    env: enabledEnv(),
    post: async () => completion('{"intent":"ai_automation","confidence":0.91}')
  });
  assert.equal(automation.faq.id, 'ai_automation');
  assert.equal(automation.faq.answer, FAQ_ENTRIES.find(({ id }) => id === 'ai_automation').answer);
});

test('Groq classification is constrained to supported intents and a confidence threshold', async () => {
  const { classifyUnmatchedQuestionWithGroq: classify } = await load();
  for (const content of [
    'not json',
    '{"intent":"company_info","confidence":0.99}',
    '{"intent":"services","confidence":"0.99"}',
    '{"intent":"services","confidence":0.99,"answer":"invented"}',
    '{"intent":"services","confidence":1.2}'
  ]) {
    const result = await classify('could you help with a natural language question', {}, {
      env: enabledEnv(), post: async () => completion(content)
    });
    assert.equal(result.status, 'invalid_response', content);
    assert.equal(result.faq, null);
  }

  const low = await classify('a paraphrased services question', {}, {
    env: enabledEnv({ GROQ_NLP_CONFIDENCE_THRESHOLD: '0.9' }),
    post: async () => completion('{"intent":"services","confidence":0.89}')
  });
  assert.equal(low.status, 'low_confidence');
  assert.equal(low.faq, null);

  const unknown = await classify('a question outside approved company facts', {}, {
    env: enabledEnv(), post: async () => completion('{"intent":"unknown","confidence":0.99}')
  });
  assert.equal(unknown.status, 'classified_unknown');
  assert.equal(unknown.faq, null);
});

test('Groq timeouts and network failures stay contained and expose only safe error metadata', async () => {
  const { classifyUnmatchedQuestionWithGroq: classify } = await load();
  const result = await classify('a question that needs fallback', {}, {
    env: enabledEnv(),
    post: async () => {
      const error = new Error('test-secret-key and customer text must not be returned');
      error.code = 'ECONNABORTED';
      throw error;
    }
  });
  assert.equal(result.attempted, true);
  assert.equal(result.status, 'request_failed');
  assert.equal(result.failureKind, 'ECONNABORTED');
  assert.equal(result.faq, null);
  assert.equal(JSON.stringify(result).includes('test-secret-key'), false);
  assert.equal(JSON.stringify(result).includes('customer text'), false);
});
