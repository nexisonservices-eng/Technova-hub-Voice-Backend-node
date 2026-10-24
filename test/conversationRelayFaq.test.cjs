const { test } = require('node:test');
const assert = require('node:assert/strict');

const importFaq = () => import('../src/services/conversationRelayFaq.js');

test('welcome is a one-time ConversationRelay greeting and FAQ answers can progress through five turns', async () => {
  const { FAQ_WELCOME, FAQ_ENTRIES, createFaqState, processFaqPrompt } = await importFaq();
  const state = createFaqState('CA0123456789abcdef0123456789abcdef');
  const turns = [
    ['What is TechnovaHub?', 'technovahub'],
    ['What services does TechnovaHub provide?', 'services'],
    ['What is Nexion?', 'nexion'],
    ['How does Nexion help businesses?', 'nexion_benefits'],
    ['Can Nexion automate repetitive tasks?', 'repetitive_tasks']
  ];

  assert.equal(FAQ_WELCOME, "Hello! Welcome to TechnovaHub. I'm your virtual assistant. How may I help you today?");
  assert.equal(state.callSid, 'CA0123456789abcdef0123456789abcdef');
  assert.equal(state.stage, 'awaiting_question');
  for (const [question, faqId] of turns) {
    const result = processFaqPrompt(state, question, { transferAvailable: true });
    assert.equal(result.action, 'answer');
    assert.equal(result.faqId, faqId);
    assert.equal(result.answer, FAQ_ENTRIES.find((entry) => entry.id === faqId).answer);
    assert.equal(state.stage, 'awaiting_question');
  }
  assert.equal(state.turns, 5);
});

test('English, Tamil and Tanglish question variants map to predefined FAQ entries', async () => {
  const { matchFaq } = await importFaq();
  const cases = [
    ['What services do you offer?', 'services'],
    ['Nexion na enna?', 'nexion'],
    ['Nexion எப்படி உதவும்?', 'nexion_benefits'],
    ['nexion eppadi help', 'nexion_benefits'],
    ['என்னென்ன சேவைகள் வழங்குகிறீர்கள்?', 'services'],
    ['offer iruka?', 'offers'],
    ['discount iruka?', 'offers'],
    ['யார் பயன்படுத்தலாம்?', 'businesses'],
    ['team kitta pesanum', 'human_representative'],
    ['TechnovaHub contact epdi?', 'contact']
  ];
  for (const [question, expectedId] of cases) {
    assert.equal(matchFaq(question)?.id, expectedId, question);
  }
});

test('unknown question gives fixed fallback and yes transfers only while that offer is pending', async () => {
  const { FAQ_RESPONSES, createFaqState, processFaqPrompt, buildFaqHandoffActions } = await importFaq();
  const state = createFaqState('CA0123456789abcdef0123456789abcdef');
  const unknown = processFaqPrompt(state, 'Can you guarantee our revenue will double?', { transferAvailable: true });
  assert.equal(unknown.faqId, 'unknown');
  assert.equal(unknown.answer, FAQ_RESPONSES.unknown);
  assert.equal(state.awaitingHumanConfirmation, true);

  const yes = processFaqPrompt(state, 'yes please', { transferAvailable: true });
  assert.equal(yes.action, 'transfer');
  assert.deepEqual(buildFaqHandoffActions({ status: 'faq_transfer' }, {
    transferOnCustomerRequest: true, humanAgentPhoneNumber: '+14155550123'
  }), [
    { type: 'say', text: 'Certainly! Please hold while I connect you with our team.' },
    { type: 'dial', destination: '+14155550123' }
  ]);
});

test('affirmative answers unrelated to a pending representative offer do not transfer', async () => {
  const { createFaqState, processFaqPrompt } = await importFaq();
  const state = createFaqState('CA0123456789abcdef0123456789abcdef');
  const result = processFaqPrompt(state, 'yes', { transferAvailable: true });
  assert.equal(result.action, 'answer');
  assert.equal(result.faqId, 'unknown');
  assert.equal(state.stage, 'awaiting_question');
});

test('NO to representative offer returns to FAQ conversation and does not end the call', async () => {
  const { FAQ_RESPONSES, createFaqState, processFaqPrompt } = await importFaq();
  const state = createFaqState('CA0123456789abcdef0123456789abcdef');
  processFaqPrompt(state, 'Do you have any discounts?', { transferAvailable: true });
  const no = processFaqPrompt(state, 'No, thank you', { transferAvailable: true });
  assert.equal(no.answer, FAQ_RESPONSES.noTransfer);
  assert.equal(no.action, 'answer');
  assert.equal(state.stage, 'awaiting_question');
  assert.equal(state.awaitingHumanConfirmation, false);
});

test('direct human request transfers; unavailable transfer never claims success', async () => {
  const { FAQ_RESPONSES, createFaqState, processFaqPrompt, buildFaqHandoffActions } = await importFaq();
  const direct = processFaqPrompt(createFaqState('CA1'), 'Can I speak to a human representative?', { transferAvailable: true });
  assert.equal(direct.action, 'transfer');

  const unavailable = processFaqPrompt(createFaqState('CA2'), 'Can I speak to a human?', { transferAvailable: false });
  assert.equal(unavailable.action, 'answer');
  assert.equal(unavailable.answer, FAQ_RESPONSES.unavailable);
  assert.deepEqual(buildFaqHandoffActions({ status: 'faq_transfer' }, {
    transferOnCustomerRequest: false, humanAgentPhoneNumber: ''
  }), [{ type: 'say', text: FAQ_RESPONSES.unavailable }, { type: 'hangup' }]);
});

test('goodbye uses the fixed closing and graceful hangup action', async () => {
  const { FAQ_RESPONSES, createFaqState, processFaqPrompt, buildFaqHandoffActions } = await importFaq();
  const state = createFaqState('CA0123456789abcdef0123456789abcdef');
  const result = processFaqPrompt(state, 'goodbye', { transferAvailable: true });
  assert.equal(result.action, 'end');
  assert.equal(result.answer, FAQ_RESPONSES.goodbye);
  assert.equal(state.stage, 'ending');
  assert.deepEqual(buildFaqHandoffActions({ status: 'faq_goodbye' }), [
    { type: 'say', text: FAQ_RESPONSES.goodbye }, { type: 'hangup' }
  ]);
});

test('thank-you FAQ answer does not end the call or repeat the welcome', async () => {
  const { FAQ_ENTRIES, createFaqState, processFaqPrompt } = await importFaq();
  const state = createFaqState('CA0123456789abcdef0123456789abcdef');
  const result = processFaqPrompt(state, 'Thank you', { transferAvailable: true });
  assert.equal(result.answer, FAQ_ENTRIES.find((entry) => entry.id === 'thanks').answer);
  assert.equal(result.action, 'answer');
  assert.equal(state.stage, 'awaiting_question');
});
