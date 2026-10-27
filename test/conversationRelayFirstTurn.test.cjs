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

    async function session(question, { blankFinal = false, interrupt = false, speechAfterSetup = false } = {}) {
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
      if (!speechAfterSetup) {
        frame({ type: 'prompt', voicePrompt: question, lang: 'ta-IN', last: false });
        frame({ type: 'prompt', voicePrompt: question, lang: 'ta-IN', last: true });
      }
      await tick();
      assert.deepEqual(socket.sent, [], 'speech must wait for workflow authorization');
      workflowGate.resolve(workflow);
      await connecting;
      await tick();
      assert.deepEqual(socket.sent, [], 'speech must wait for setup association too');
      setupGate.resolve({ callSid: CALL, userId: 'tenant', workflowId: 'workflow' });
      await tick();
      await tick();
      if (speechAfterSetup) {
        await prompt(question, false);
        assert.deepEqual(socket.sent, [], 'partial alone must not select any response');
        await prompt(question);
      }
      return { socket, prompt, frame };
    }

    await t.test('enabled NLP routes multilingual first finals once and blocks embedded consent', async () => {
      const oldFlag = process.env.CONVERSATION_RELAY_MULTILINGUAL_NLP;
      process.env.CONVERSATION_RELAY_MULTILINGUAL_NLP = 'true';
      let socket;
      try {
        const active = await session('என்ன சேவைகள் செய்கிறீர்கள்?', { speechAfterSetup: true });
        socket = active.socket;
        const { prompt } = active;
        assert.deepEqual(socket.sent.map((frame) => frame.token), [services]);
        await prompt('ஏஐ ஆட்டோமேஷன் என்றால் என்ன?', false);
        assert.equal(socket.sent.length, 1);
        await prompt('ஏஐ ஆட்டோமேஷன் என்றால் என்ன?');
        assert.equal(socket.sent.at(-1).token, automation);
        await prompt('Yeah can you explain my mortgage');
        assert.equal(socket.sent.some((frame) => frame.type === 'end'), false);
        await prompt('Enna services pandringa?');
        await prompt('Enna services pandringa?');
        assert.deepEqual(socket.sent.slice(-2).map((frame) => frame.token), [services, services]);
        const detected = logs.filter((entry) => entry.event === 'relay_intent_recognized');
        assert.equal(detected[0].intent, 'COMPANY_SERVICES');
        assert.ok(detected.every((entry) => entry.processingLatencyMs >= 0));
        const logged = JSON.stringify(logs);
        assert.equal(logged.includes('mortgage'), false);
        await prompt('unlisted question');
        await prompt('No');
        await prompt('AI automation na enna?');
        await prompt('Yes');
        await prompt('Yes');
        assert.equal(socket.sent.filter((frame) => frame.type === 'end').length, 1);
      } finally {
        socket?.close();
        if (oldFlag === undefined) delete process.env.CONVERSATION_RELAY_MULTILINGUAL_NLP;
        else process.env.CONVERSATION_RELAY_MULTILINGUAL_NLP = oldFlag;
      }
    });

    const variants = [
      ['Yeah, automationальна.', automation],
      ['AI automationальна na enna?', automation],
      ['என்ன service?', services],
      ['என்னென்ன service பண்றீங்க?', services],
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
    await t.test('reported mixed-script topic after a pending offer answers once, then NO and YES keep existing transfer behavior', async () => {
      const { socket, prompt } = await session('unlisted question');
      try {
        await prompt('Yeah, automationальна.', false);
        assert.equal(socket.sent.length, 1, 'partial must not accept the pending transfer');
        await prompt('Yeah, automationальна.');
        assert.deepEqual(socket.sent.map((frame) => frame.type), ['text', 'text']);
        assert.equal(socket.sent.at(-1).token, automation);
        await prompt('No');
        await prompt('Enna services pandringa?');
        assert.equal(socket.sent.at(-1).token, services);
        await prompt('Yeah, automationальна.');
        assert.equal(socket.sent.at(-1).token, automation);
        await prompt('Yeah, automationальна.');
        assert.equal(socket.sent.at(-1).token, automation);
        assert.equal(socket.sent.some((frame) => frame.type === 'end'), false);
        await prompt('Yes');
        assert.equal(socket.sent.at(-2).token, 'சரி! ஒரு நிமிஷம் வெயிட் பண்ணுங்க. உங்களை எங்க டீம் கூட கனெக்ட் பண்றேன்.');
        assert.deepEqual(JSON.parse(socket.sent.at(-1).handoffData), { status: 'faq_transfer', faqId: 'ai_automation' });
        assert.equal(socket.sent.filter((frame) => frame.type === 'end').length, 1);
      } finally { socket.close(); }
    });
    await t.test('human-transfer NO continues and a later plain Yeah accepts only the pending human offer', async () => {
      const { socket, prompt } = await session('unlisted question');
      try {
        await prompt('No');
        await prompt('Enna services pandringa?');
        assert.equal(socket.sent.at(-1).token, services);
        assert.equal(socket.sent.some((frame) => frame.type === 'end'), false);
        await prompt('unlisted question');
        const beforePartial = socket.sent.length;
        await prompt('Yeah', false);
        assert.equal(socket.sent.length, beforePartial);
        await prompt('Yeah');
        assert.equal(socket.sent.filter((frame) => frame.type === 'end').length, 1);
        assert.deepEqual(JSON.parse(socket.sent.at(-1).handoffData), {
          status: 'faq_transfer', faqId: 'human_representative'
        });
      } finally { socket.close(); }
    });
    for (const [question, answer] of variants) await t.test(`after setup: ${question}`, async () => {
      const { socket } = await session(question, { speechAfterSetup: true });
      try {
        assert.deepEqual(socket.sent.map((frame) => frame.token), [answer]);
        const decision = logs.find((entry) => entry.event === 'relay_faq_decision');
        assert.equal(decision.candidateFaqId, decision.selectedFaqId);
        assert.equal(decision.fallbackReason, null);
        assert.equal(decision.stateBefore.faqReady, true);
        assert.equal(decision.stateBefore.awaitingHumanConfirmation, false);
      } finally { socket.close(); }
    });
    await t.test('runtime trace distinguishes raw arrival, queued processing, state and writes', async () => {
      const oldCommit = process.env.RENDER_GIT_COMMIT;
      process.env.RENDER_GIT_COMMIT = 'a'.repeat(40);
      const { socket, prompt, frame } = await session('Enna services pandringa?', { interrupt: true });
      try {
        const diagnostics = () => logs.filter((entry) => entry.diagnosticVersion === 'relay_first_speech_v2');
        const identity = diagnostics().find((entry) => entry.event === 'relay_runtime_identity');
        assert.equal(identity.deployedCommit, 'a'.repeat(40));
        assert.match(identity.faqConfigurationHash, /^[a-f0-9]{64}$/);
        assert.ok(identity.handlerInstanceId);
        const arrivals = diagnostics().filter((entry) => entry.event === 'relay_frame_received');
        assert.deepEqual(arrivals.map((entry) => entry.frameSequence), [1, 2, 3, 4]);
        assert.equal(arrivals[0].faqReady, false);
        assert.ok(arrivals.every((entry) => entry.messageListenerCount === 1));
        const processed = diagnostics().filter((entry) => entry.event === 'relay_frame_processing');
        assert.deepEqual(processed.map((entry) => entry.frameSequence), [1, 2, 3, 4]);
        assert.equal(processed[2].faqReady, true);
        assert.ok(processed.every((entry) => Number.isFinite(entry.queueWaitMs)));
        assert.ok(diagnostics().some((entry) => entry.event === 'relay_interruption'));
        const decision = diagnostics().find((entry) => entry.event === 'relay_faq_decision');
        assert.equal(decision.candidateFaqId, 'services');
        assert.equal(decision.selectedFaqId, 'services');
        assert.equal(decision.stateBefore.awaitingHumanConfirmation, false);
        assert.equal(decision.stateAfter.awaitingHumanConfirmation, false);
        assert.equal(diagnostics().filter((entry) => entry.event === 'relay_output_attempt').length, 1);
        assert.equal(diagnostics().find((entry) => entry.event === 'relay_output_write').written, true);
        await prompt('Enna services pandringa?');
        const inputs = diagnostics().filter((entry) => entry.event === 'relay_faq_input');
        assert.equal(inputs[0].sameAsPreviousFinal, false);
        assert.equal(inputs[1].sameAsPreviousFinal, true);
        assert.equal(inputs[0].normalizedFingerprint, inputs[1].normalizedFingerprint);
        assert.equal(socket.sent.length, 2, 'intentional repetition still receives its own answer');
        const beforeInvalid = socket.sent.length;
        frame({ type: 'prompt', voicePrompt: 'Enna services pandringa?', last: 'true' });
        await tick();
        assert.equal(socket.sent.length, beforeInvalid);
        assert.ok(diagnostics().some((entry) => entry.event === 'relay_prompt_disposition'
          && entry.reason === 'invalid_last_flag' && entry.lastFieldType === 'string'));
        const traceText = JSON.stringify(diagnostics());
        for (const value of ['Enna services pandringa?', 'enna services pandringa', '+14155550222', 'Welcome']) {
          assert.equal(traceText.includes(value), false, 'new trace must not contain transcript or destination');
        }
      } finally {
        socket.close();
        if (oldCommit === undefined) delete process.env.RENDER_GIT_COMMIT;
        else process.env.RENDER_GIT_COMMIT = oldCommit;
      }
      assert.ok(logs.some((entry) => entry.event === 'relay_session_summary'));
    });
    await t.test('runtime trace correlates asynchronous write errors without changing FAQ output', async () => {
      const { socket, prompt } = await session('Enna services pandringa?');
      try {
        socket.send = (frame, callback) => {
          socket.sent.push(JSON.parse(frame));
          setImmediate(() => callback(new Error('simulated write failure')));
        };
        await prompt('Enna services pandringa?');
        await tick();
        assert.equal(socket.sent.at(-1).token, services);
        const write = logs.find((entry) => entry.event === 'relay_output_write' && entry.written === false);
        assert.equal(write.outboundFrame, 2);
        assert.equal(write.customerTurn, 2);
        assert.equal(write.correlationId, CALL);
        assert.equal(write.errorType, 'Error');
        assert.equal(socket.sent.length, 2);
      } finally { socket.close(); }
    });
    await t.test('runtime trace shows fallback creates pending offer, NO clears it, and services recovers', async () => {
      const { socket, prompt } = await session('Enna services pandringa?');
      try {
        await prompt('unlisted question');
        await prompt('No');
        await prompt('Enna services pandringa?');
        const decisions = logs.filter((entry) => entry.event === 'relay_faq_decision');
        assert.deepEqual(decisions.map((entry) => entry.selectedFaqId), ['services', 'unknown', 'declined_transfer', 'services']);
        assert.equal(decisions[1].fallbackReason, 'no_faq_intent_match');
        assert.equal(decisions[1].stateBefore.awaitingHumanConfirmation, false);
        assert.equal(decisions[1].stateAfter.awaitingHumanConfirmation, true);
        assert.equal(decisions[2].stateBefore.awaitingHumanConfirmation, true);
        assert.equal(decisions[2].stateAfter.awaitingHumanConfirmation, false);
        assert.equal(socket.sent.length, 4);
        assert.equal(socket.sent.at(-1).token, services);
      } finally { socket.close(); }
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
        assert.equal(partial.receivedTranscription, '[transcript omitted]');
        assert.equal(final.receivedTranscription, '[transcript omitted]');
        assert.ok(partial.turn < final.turn);
        assert.equal(logs.find((entry) => entry.event === 'normalized_prompt' && entry.turn === final.turn)
          .normalizedTranscription, '[transcript omitted]');
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
