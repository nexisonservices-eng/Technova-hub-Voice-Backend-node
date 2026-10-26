const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerHooks } = require('node:module');

// Execute the real WebSocket handler, queue, FAQ, configuration and session
// modules. Replace only external SDKs, persistence, credentials and logging.
// No network, credentials, LLM, database, or installed SDKs are used here.
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((done) => setImmediate(done));
const query = (value) => ({ select() { return this; }, lean: () => Promise.resolve(value) });
const CALL = 'CA' + 'b'.repeat(32);
const services = 'நம்ம TechnovaHub-ல IT சர்வீசஸ், AI ஆட்டோமேஷன், டிஜிட்டல் டிரான்ஸ்ஃபர்மேஷன் சர்வீசஸ் எல்லாம் பண்ணிட்டு இருக்கோம்.';
const automation = 'எங்களோட AI ஆட்டோமேஷன் சர்வீசஸ்க்கு சில ஸ்பெஷல் ஆஃபர்ஸ் இருக்கு. அதைப் பத்தி இன்னும் டீடெயிலா தெரிஞ்சிக்க உங்களை எங்க டீம் கூட கனெக்ட் பண்ணட்டுமா?';

test('real WebSocket first-turn flow waits for workflow and setup, then answers without repetition', async (t) => {
  const logs = [];
  const fixtures = {
    twilio: {}, ws: { OPEN: 1 },
    Workflow: {}, Call: {}, ExecutionLog: {}, adminCredentialsService: {},
    logger: Object.fromEntries(['info', 'warn', 'error'].map((level) =>
      [level, (message, fields) => logs.push({ message, ...fields })]))
  };
  globalThis.__relayFirstTurnFixtures = fixtures;
  const mocks = {
    twilio: 'twilio', ws: 'ws', '../models/Workflow.js': 'Workflow',
    '../models/call.js': 'Call', '../models/ExecutionLog.js': 'ExecutionLog',
    './adminCredentialsService.js': 'adminCredentialsService', '../utils/logger.js': 'logger'
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.split('?')[0].endsWith('/conversationRelayService.js') && mocks[specifier]) {
        return { url: `relay-first-turn:${mocks[specifier]}`, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith('relay-first-turn:')) return {
        format: 'module', shortCircuit: true,
        source: `export default globalThis.__relayFirstTurnFixtures[${JSON.stringify(url.split(':')[1])}];`
      };
      return next(url, context);
    }
  });
  try {
    const { default: service } = await import('../src/services/conversationRelayService.js?first-turn-test');
    const { FAQ_WELCOME } = await import('../src/services/conversationRelayFaq.js');
    const { buildConversationRelayTwiML } = await import('../src/config/conversationRelay.js');
    // Twilio speaks the welcome from TwiML; the WebSocket never sends it again.
    assert.ok(buildConversationRelayTwiML({
      url: 'wss://example.test/ws/conversation-relay', action: 'https://example.test/complete',
      welcomeGreeting: FAQ_WELCOME, language: 'ta-IN', voice: 'ZhJ5LanYnCmLKQUXvsV7'
    }).includes(`welcomeGreeting="${FAQ_WELCOME}"`));

    async function session(question, { blankFinal = false, interrupt = false } = {}) {
      logs.length = 0;
      const workflowGate = deferred();
      const setupGate = deferred();
      const workflow = { nodes: [
        { id: 'agent', type: 'ai_voice_agent', data: {
          language: 'ta-IN', voiceSelection: 'ZhJ5LanYnCmLKQUXvsV7', transferOnCustomerRequest: true
        } },
        { id: 'team', type: 'handoff', data: { destination: '+14155550222' } }
      ], edges: [{ source: 'agent', sourceHandle: 'completed', target: 'team' }] };
      fixtures.Workflow.findOne = (filter) => {
        assert.deepEqual(filter, { _id: 'workflow', createdBy: 'tenant' });
        return query(workflowGate.promise);
      };
      fixtures.ExecutionLog.findOne = () => query(setupGate.promise);
      fixtures.Call.findOne = () => query({ callSid: CALL, user: 'tenant', provider: 'twilio',
        providerData: { workflowId: 'workflow', direction: 'outbound' } });
      const socket = new EventEmitter();
      socket.readyState = 1;
      socket.sent = [];
      socket.send = (frame, callback) => { socket.sent.push(JSON.parse(frame)); callback?.(); };
      socket.close = () => socket.emit('close', 1000, '');
      const frame = (message) => socket.emit('message', Buffer.from(JSON.stringify(message)));
      const prompt = async (voicePrompt, last = true) => {
        frame({ type: 'prompt', voicePrompt, lang: 'ta-IN', last });
        await tick();
      };
      const connecting = service.handleConnection(socket, {
        url: '/ws/conversation-relay?userId=tenant&workflowId=workflow&nodeId=agent'
      });
      frame({ type: 'setup', callSid: CALL, sessionId: 'test-session' });
      if (interrupt) frame({ type: 'interrupt', utteranceUntilInterrupt: 'Welcome', durationUntilInterruptMs: 100 });
      if (blankFinal) frame({ type: 'prompt', voicePrompt: '', last: true });
      frame({ type: 'prompt', voicePrompt: question, lang: 'ta-IN', last: false });
      frame({ type: 'prompt', voicePrompt: question, lang: 'ta-IN', last: true });
      await tick();
      assert.deepEqual(socket.sent, [], 'speech must wait for workflow authorization');
      workflowGate.resolve(workflow);
      await connecting;
      await tick();
      assert.deepEqual(socket.sent, [], 'speech must wait for setup association too');
      setupGate.resolve({ callSid: CALL, userId: 'tenant', workflowId: 'workflow' });
      await tick();
      await tick();
      return { socket, prompt };
    }

    const variants = [
      ['Enna services pandringa?', services],
      ['Enna service pandringa?', services], ['Enna service panreenga?', services],
      ['என்ன சர்வீசஸ் பண்றீங்க?', services], ['What services do you provide?', services],
      ['AI automation na enna?', automation], ['ஏஐ ஆட்டோமேஷன் என்ன?', automation],
      ['What is AI automation?', automation]
    ];
    for (const [question, answer] of variants) await t.test(question, async () => {
      const { socket, prompt } = await session(question);
      try {
        assert.deepEqual(socket.sent.map((frame) => frame.token), [answer]);
        const events = logs.map((entry) => entry.event);
        for (const event of ['session_initialized', 'faq_configuration_ready', 'first_turn_received',
          'transcription_received', 'normalized_transcription', 'faq_match_result', 'response_selected']) {
          assert.ok(events.includes(event), `missing diagnostic ${event}`);
        }
        assert.ok(events.indexOf('session_initialized') < events.indexOf('faq_configuration_ready'));
        assert.ok(events.indexOf('faq_configuration_ready') < events.indexOf('first_turn_received'));
        const firstTurn = logs.find((entry) => entry.event === 'first_turn_received');
        assert.equal(firstTurn.correlationId, CALL);
        assert.equal(firstTurn.faqReady, true);
        assert.equal(firstTurn.awaitingHumanConfirmation, false);
        assert.equal(firstTurn.awaitingAutomationConfirmation, false);
        assert.equal(JSON.stringify(logs).includes('+14155550222'), false);
        await prompt(question);
        assert.equal(socket.sent.at(-1).token, answer, 'identical first and repeated question must agree');
        assert.equal(logs.filter((entry) => entry.event === 'first_turn_received').length, 1);
        assert.equal(socket.sent.some((frame) => frame.type === 'end'), false);
      } finally { socket.close(); }
    });
    await t.test('empty final event must not offer handoff before the first question', async () => {
      const { socket } = await session('Enna service pandringa?', { blankFinal: true });
      try { assert.deepEqual(socket.sent.map((frame) => frame.token), [services]); }
      finally { socket.close(); }
    });
    // The actual pre-09:34:38 frames are unavailable. This is a control for
    // the reported wording and an interrupt event, not a production replay.
    await t.test('reported services wording after interrupt matches on the first final without a pending offer', async () => {
      const question = 'Enna services pandringa?';
      const { socket, prompt } = await session(question, { interrupt: true });
      try {
        assert.deepEqual(socket.sent.map((frame) => frame.token), [services]);
        const partial = logs.find((entry) => entry.event === 'prompt_received' && !entry.last);
        const final = logs.find((entry) => entry.event === 'prompt_received' && entry.last);
        assert.equal(partial.receivedTranscription, question);
        assert.equal(final.receivedTranscription, question);
        assert.ok(partial.turn < final.turn);
        assert.equal(logs.find((entry) => entry.event === 'normalized_prompt' && entry.turn === final.turn)
          .normalizedTranscription, 'enna services pandringa');
        const matches = logs.filter((entry) => entry.event === 'faq_match_result');
        assert.equal(matches.length, 1, 'partial and interrupt events must not route a question');
        assert.equal(matches[0].turn, final.turn);
        assert.equal(matches[0].customerTurn, 1);
        assert.equal(matches[0].faqId, 'services');
        assert.equal(matches[0].awaitingHumanConfirmation, false);
        assert.equal(matches[0].awaitingAutomationConfirmation, false);
        assert.equal(logs.find((entry) => entry.event === 'response_selected').selectedResponse, services);
        assert.equal(logs.some((entry) => ['fallback_reason', 'faq_fallback_reason'].includes(entry.event)), false);
        await prompt('No');
        assert.notEqual(logs.filter((entry) => entry.event === 'faq_match_result').at(-1).faqId,
          'declined_transfer', 'services alone must not leave a human-transfer offer pending');
        await prompt(question);
        assert.equal(socket.sent.at(-1).token, services);
        assert.equal(socket.sent.some((frame) => frame.type === 'end'), false);
      } finally { socket.close(); }
    });
    await t.test('NO continues, YES transfers only with a pending offer', async () => {
      const { socket, prompt } = await session('Enna service pandringa?');
      try {
        await prompt('Yes');
        assert.equal(socket.sent.some((frame) => frame.type === 'end'), false);
        await prompt('No');
        await prompt('Enna service pandringa?');
        assert.equal(socket.sent.at(-1).token, services);
        await prompt('AI automation na enna?');
        await prompt('No');
        await prompt('Enna service pandringa?');
        assert.equal(socket.sent.at(-1).token, services);
        await prompt('AI automation na enna?');
        const beforeEmpty = socket.sent.length;
        await prompt('...');
        assert.equal(socket.sent.length, beforeEmpty, 'noise must not clear a pending confirmation');
        await prompt('Yes', false);
        assert.equal(socket.sent.some((frame) => frame.type === 'end'), false);
        await prompt('Yes');
        assert.equal(socket.sent.at(-2).token, 'சரி! ஒரு நிமிஷம் வெயிட் பண்ணுங்க. உங்களை எங்க டீம் கூட கனெக்ட் பண்றேன்.');
        assert.deepEqual(JSON.parse(socket.sent.at(-1).handoffData), { status: 'faq_transfer', faqId: 'ai_automation' });
      } finally { socket.close(); }
    });
  } finally {
    hooks.deregister();
    delete globalThis.__relayFirstTurnFixtures;
  }
});
