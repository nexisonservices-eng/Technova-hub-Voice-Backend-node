const { test } = require('node:test');
const assert = require('node:assert/strict');

const loadService = () => import('../src/services/conversationRelayOpenAI.js');
const validRequest = {
  transcript: 'Adhu epdi work aagum?',
  history: [{ role: 'user', content: 'AI automation na enna?' }, { role: 'assistant', content: 'It automates tasks.' }],
  systemPrompt: 'Be a concise receptionist.',
  knowledgeBase: 'TechnovaHub provides IT services and AI automation.',
  companyName: 'TechnovaHub',
  language: 'ta-IN',
  env: { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '2500' }
};

test('Responses API sends approved context and returns bounded answer text without storing the conversation', async () => {
  const { generateConversationAnswer } = await loadService();
  let captured;
  const result = await generateConversationAnswer({
    ...validRequest,
    post: async (...args) => {
      captured = args;
      return { status: 200, headers: { 'x-request-id': 'req-safe' }, data: {
        status: 'completed', output_text: 'AI automation can handle routine workflow steps.'
      } };
    }
  });
  assert.equal(result.success, true);
  assert.equal(result.answer, 'AI automation can handle routine workflow steps.');
  assert.equal(captured[0], 'https://api.openai.com/v1/responses');
  assert.equal(captured[1].store, false);
  assert.equal(captured[1].model, 'test-model');
  assert.equal(captured[2].httpsAgent.options.keepAlive, true);
  assert.equal(captured[1].input.at(-1).content, validRequest.transcript);
  assert.ok(captured[1].instructions.includes(validRequest.knowledgeBase));
  assert.ok(captured[1].instructions.includes('ta-IN'));
  assert.equal(captured[2].timeout, 2500);
  assert.equal(captured[2].headers.Authorization, 'Bearer test-key');
});

test('timeout and provider errors return safe statuses without exposing provider messages', async () => {
  const { generateConversationAnswer } = await loadService();
  const timeout = await generateConversationAnswer({
    ...validRequest,
    post: async () => { const error = new Error('private caller data'); error.code = 'ECONNABORTED'; throw error; }
  });
  assert.equal(timeout.reason, 'timeout');
  assert.equal(JSON.stringify(timeout).includes('private caller data'), false);

  const provider = await generateConversationAnswer({
    ...validRequest,
    post: async () => { const error = new Error('secret error body'); error.response = { status: 503 }; throw error; }
  });
  assert.equal(provider.reason, 'provider_error');
  assert.equal(provider.status, 503);
  assert.equal(JSON.stringify(provider).includes('secret error body'), false);
});

test('missing credentials, empty output, malformed responses, and oversized output fail closed', async () => {
  const { generateConversationAnswer } = await loadService();
  let called = false;
  const missing = await generateConversationAnswer({
    ...validRequest, env: {}, post: async () => { called = true; }
  });
  assert.equal(missing.reason, 'missing_configuration');
  assert.equal(called, false);

  for (const response of [
    { status: 200, data: { status: 'completed', output_text: '  ' } },
    { status: 200, data: { status: 'incomplete', output_text: 'partial' } },
    { status: 200, data: { output_text: 'missing status' } },
    { status: 200, data: { status: 'completed', output: [{ type: 'refusal', refusal: 'not text' }] } },
    { status: 200, data: { status: 'completed', output_text: 'a'.repeat(851) } },
    { status: 500, data: { status: 'completed', output_text: 'unexpected' } }
  ]) {
    const result = await generateConversationAnswer({ ...validRequest, post: async () => response });
    assert.equal(result.success, false);
  }
});

test('separate call histories remain isolated in API input', async () => {
  const { generateConversationAnswer } = await loadService();
  const firstCallHistory = [{ role: 'user', content: 'First caller private context' }];
  const secondCallHistory = [{ role: 'user', content: 'Second caller context' }];
  const requests = [];
  const post = async (_url, body) => {
    requests.push(body);
    return { status: 200, data: { status: 'completed', output_text: 'Answer.' } };
  };
  await generateConversationAnswer({ ...validRequest, history: firstCallHistory, post });
  await generateConversationAnswer({ ...validRequest, history: secondCallHistory, post });
  assert.equal(requests[0].input.some(({ content }) => content.includes('Second caller')), false);
  assert.equal(requests[1].input.some(({ content }) => content.includes('First caller')), false);
});

test('OpenAI input keeps only the most recent two exchanges', async () => {
  const { generateConversationAnswer, OPENAI_HISTORY_LIMIT } = await loadService();
  let body;
  await generateConversationAnswer({
    ...validRequest,
    history: Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', content: `turn ${index}`
    })),
    post: async (_url, requestBody) => {
      body = requestBody;
      return { status: 200, data: { status: 'completed', output_text: 'Brief answer.' } };
    }
  });
  assert.equal(OPENAI_HISTORY_LIMIT, 4);
  assert.deepEqual(body.input.slice(0, 4).map(({ content }) => content), ['turn 6', 'turn 7', 'turn 8', 'turn 9']);
});
