const { test } = require('node:test');
const assert = require('node:assert/strict');

const loadIntent = () => import('../src/services/conversationRelayIntent.js');
const loadFaq = () => import('../src/services/conversationRelayFaq.js');

test('labelled English, Tamil, Tanglish, mixed-script, paraphrase and FAQ-topic corpus stays grounded', async () => {
  const { recognizeMultilingualIntent: recognize } = await loadIntent();
  const labelled = [
    ['What services do you provide?', 'services'],
    ['What does your company actually do?', 'services'],
    ['How can you help my business?', 'services'],
    ['Enna services pandringa?', 'services'],
    ['Neenga enna services pandreenga?', 'services'],
    ['Neenga, enna services pandreenga!', 'services'],
    ['Neenga enna services offer panreenga?', 'services'],
    ['என்ன சேவைகள் செய்கிறீர்கள்?', 'services'],
    ['என்ன services பண்றீங்க?', 'services'],
    ['What is AI automation?', 'ai_automation'],
    ['AI automation na enna?', 'ai_automation'],
    ['Manual work ah AI vechu epdi reduce pannalam?', 'ai_automation'],
    ['AI ஆட்டோமேஷன் என்ன?', 'ai_automation'],
    ['What does TechnovaHub actually do?', 'technovahub'],
    ['Nexion enna pannum?', 'nexion'],
    ['How does Nexion help?', 'nexion_benefits'],
    ['Can Nexion automate repetitive tasks?', 'repetitive_tasks'],
    ['Which industries can use these solutions?', 'businesses'],
    ['What is the contact number?', 'contact'],
    ['Do you have any offers?', 'offers'],
    ['Can I speak to a human representative?', 'human_representative'],
    ['Thank you', 'thanks'],
    ['Hello', 'greeting'],
    ['Goodbye', 'goodbye'],
    ['How much does it cost?', null],
    ['Can you guarantee our revenue doubles?', null]
  ];
  const { FAQ_ENTRIES } = await loadFaq();
  let correct = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let fallbackCount = 0;
  let falseHandoffs = 0;
  const latencies = [];
  for (const [text, expectedId] of labelled) {
    const result = recognize(text);
    const predictedId = result.faq?.id || null;
    assert.equal(predictedId, expectedId, `${text}: ${result.reason}`);
    if (predictedId === expectedId) correct += 1;
    if (expectedId && predictedId) truePositive += 1;
    if (!expectedId && predictedId) falsePositive += 1;
    if (expectedId && !predictedId) falseNegative += 1;
    if (!predictedId) fallbackCount += 1;
    if (predictedId === 'human_representative' && expectedId !== 'human_representative') falseHandoffs += 1;
    latencies.push(result.latencyMs);
    if (expectedId && expectedId !== 'goodbye') {
      assert.equal(result.faq.answer, FAQ_ENTRIES.find(({ id }) => id === expectedId).answer, text);
    }
  }
  const accuracy = correct / labelled.length;
  const precision = truePositive / (truePositive + falsePositive);
  const recall = truePositive / (truePositive + falseNegative);
  const fallbackRate = fallbackCount / labelled.length;
  console.info(`NLP labelled corpus: ${correct}/${labelled.length} correct; accuracy=${accuracy.toFixed(3)}; precision=${precision.toFixed(3)}; recall=${recall.toFixed(3)}; fallbackRate=${fallbackRate.toFixed(3)}; falseHandoffs=${falseHandoffs}; max local recognition latency=${Math.max(...latencies).toFixed(3)}ms`);
  assert.equal(accuracy, 1);
});

test('uncertain input, pricing, negated or merely mentioned handoff requests fail safely', async () => {
  const { recognizeMultilingualIntent: recognize, detectTranscriptLanguage } = await loadIntent();
  for (const text of [null, {}, '', '   ', 'a'.repeat(3001), 'What is payroll automation?', 'Can you give me a price quote?']) {
    const result = recognize(text);
    assert.equal(result.faq, null, String(text));
    assert.ok(result.fallbackReason);
  }
  assert.equal(recognize('Human representatives are available?').faq, null);
  assert.equal(recognize("I don't want to speak to a human").faq, null);
  assert.equal(recognize('Human kitta pesanum').faq.id, 'human_representative');
  assert.equal(recognize('Agent kitta connect pannunga').faq.id, 'human_representative');
  assert.ok(recognize('What does Nexion do?').entities.includes('nexion'));
  assert.equal(detectTranscriptLanguage('என்ன services'), 'mixed-ta-latin');
  assert.equal(detectTranscriptLanguage('enna services'), 'tanglish');
  assert.equal(recognize('enna services', { providerLanguage: 'ta-IN' }).sttLanguageHint, 'ta-IN');
  assert.equal(recognize('enna services', { providerLanguage: 'customer text' }).sttLanguageHint, null);
  assert.equal(recognize('What services do you provide?', {
    env: { CONVERSATION_RELAY_NLP_DIRECT_THRESHOLD: '0.7' }
  }).threshold, 0.7);
  const conservative = recognize('What services do you provide?', {
    env: { CONVERSATION_RELAY_NLP_DIRECT_THRESHOLD: '1' }
  });
  assert.equal(conservative.faq, null);
  assert.equal(conservative.fallbackReason, 'low_confidence');
  const conservativeHandoff = recognize('Please connect me to a human', {
    env: { CONVERSATION_RELAY_NLP_HANDOFF_THRESHOLD: '1' }
  });
  assert.equal(conservativeHandoff.faq, null);
  assert.equal(conservativeHandoff.fallbackReason, 'low_confidence');
});

test('opt-in resolver separates known answers, missing company knowledge, curated unrelated topics and unclear input', async () => {
  const { recognizeMultilingualIntent: recognize } = await loadIntent();
  for (const [question, faqId] of [
    ['What services do you provide?', 'services'],
    ['What is AI automation?', 'ai_automation']
  ]) {
    const result = recognize(question);
    assert.equal(result.faq?.id, faqId);
    assert.equal(result.classification, 'known_faq');
  }

  for (const question of [
    'What is TechnovaHub pricing?',
    'What is your refund policy?',
    'What are Nexion cancellation terms?'
  ]) {
    const result = recognize(question);
    assert.equal(result.faq, null, question);
    assert.equal(result.classification, 'company_unanswered', question);
  }

  for (const question of [
    'latest cricket scores', 'Who won the cricket match?',
    'recommend a movie', 'What movie should I watch?',
    'tell me a trivia fact'
  ]) {
    const result = recognize(question);
    assert.equal(result.faq, null, question);
    assert.equal(result.classification, 'unrelated', question);
  }

  for (const question of ['How much does it cost?', 'Could you clarify?', 'What is payroll automation?']) {
    const result = recognize(question);
    assert.equal(result.faq, null, question);
    assert.equal(result.classification, 'unclear', question);
  }
  const ambiguous = recognize('Nexion services offers', {
    env: { CONVERSATION_RELAY_NLP_SEMANTIC_THRESHOLD: '0.5' }
  });
  assert.equal(ambiguous.reason, 'ambiguous');
  assert.equal(ambiguous.fallbackReason, 'conflicting_intents');
  assert.equal(ambiguous.classification, 'unclear');

  const companyWins = recognize('TechnovaHub cricket scores');
  assert.equal(companyWins.classification, 'company_unanswered');
});

test('new topic wins over context; supported follow-ups repeat only the last approved answer', async () => {
  const { FAQ_RESPONSES, createFaqState, processFaqPrompt } = await loadFaq();
  const state = createFaqState();
  const turn = (prompt) => processFaqPrompt(state, prompt, { transferAvailable: true, contextEnabled: true });
  const services = turn('What services do you provide?');
  const repeated = turn('Can you explain that again?');
  assert.equal(repeated.faqId, 'services');
  assert.equal(repeated.answer, services.answer);
  assert.equal(repeated.contextResolution, 'previous_approved_answer_repeated');
  assert.equal(turn('First service pathi konjam explain pannunga.').faqId, 'services');
  const topicChange = turn('What is Nexion?');
  assert.equal(topicChange.faqId, 'nexion');
  assert.equal(turn('Tell me more about the first one.').faqId, 'nexion');
  const legacyState = createFaqState();
  processFaqPrompt(legacyState, 'What services do you provide?', { transferAvailable: true });
  assert.equal(processFaqPrompt(legacyState, 'Can you explain that again?', { transferAvailable: true }).answer,
    FAQ_RESPONSES.unknown, 'flag-off legacy behavior does not use contextual resolution');
});

test('greetings, goodbyes and direct transfer wording require safe boundaries', async () => {
  const { matchFaq, createFaqState, processFaqPrompt } = await loadFaq();
  const { recognizeMultilingualIntent: recognize, resolveConversationRelayIntent: resolve } = await loadIntent();
  assert.equal(recognize('Hello').faq?.id, 'greeting');
  assert.equal(matchFaq('Maybe you can explain Nexion')?.id, 'nexion');
  assert.equal(recognize("I don't want to end the call").faq, null);
  assert.equal(recognize('How can I reach a human representative?').faq, null);
  assert.equal(recognize('Can you talk about a human representative?').faq, null);
  assert.equal(matchFaq('Please connect me to a human')?.id, 'human_representative');
  assert.equal(resolve('Can you talk about a human representative?', { enabled: false }).faq?.id, 'human_representative');
  const state = createFaqState();
  assert.equal(processFaqPrompt(state, 'Yeah', { transferAvailable: true }).action, 'answer');
  assert.notEqual(state.stage, 'transferring');
});
