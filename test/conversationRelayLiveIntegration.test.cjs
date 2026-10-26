const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
let routeDependenciesAvailable = true;
try { require.resolve('twilio'); require.resolve('express'); } catch { routeDependenciesAvailable = false; }

const CUSTOMER_A = '+14155550111';
const TEAM_B = '+14155550222';
const CALL_SID = 'CA' + 'a'.repeat(32);
const USER_ID = 'tenant-test';
const WORKFLOW_ID = 'workflow-test';
const NODE_ID = 'voice-agent';

const query = (value) => ({ select() { return this; }, lean: async () => value });
const delay = () => new Promise((resolve) => setTimeout(resolve, 10));

const makeWorkflow = () => ({
  _id: WORKFLOW_ID,
  createdBy: USER_ID,
  nodes: [
    { id: NODE_ID, type: 'ai_voice_agent', data: {
      language: 'ta-IN', voiceSelection: 'ZhJ5LanYnCmLKQUXvsV7',
      transferOnCustomerRequest: true, transferOnDiscountInterest: false,
      humanAgentPhoneNumber: ''
    } },
    { id: 'team-handoff', type: 'handoff', data: { destination: TEAM_B } },
    { id: 'end', type: 'end', data: {} }
  ],
  edges: [
    // This is the saved workflow's legacy edge label from AI Voice Agent → Hand Off.
    { source: NODE_ID, sourceHandle: 'completed', target: 'team-handoff' },
    { source: 'team-handoff', sourceHandle: 'connected', target: 'end' }
  ]
});

const sendFrame = async (socket, frame) => {
  socket.emit('message', Buffer.from(JSON.stringify(frame)));
  await delay();
};

test('live ConversationRelay prompt flow and completion callback transfer to Hand Off Team B for inbound/outbound calls',
  { skip: !routeDependenciesAvailable }, async () => {
  const [{ default: relayService }, Workflow, Call, ExecutionLog, WorkflowExecution,
    twilioIntegrationService, router, twilio] = await Promise.all([
    import('../src/services/conversationRelayService.js'),
    import('../src/models/Workflow.js'), import('../src/models/call.js'),
    import('../src/models/ExecutionLog.js'), import('../src/models/WorkflowExecution.js'),
    import('../src/services/twilioIntegrationService.js'), import('../src/routes/twilioWebhookRoutes.js'),
    import('twilio')
  ]);

  const originals = {
    workflow: Workflow.default.findOne, call: Call.default.findOne,
    execution: ExecutionLog.default.findOne, legacy: WorkflowExecution.default.findOne,
    transferComplete: twilioIntegrationService.default.handleTransferComplete
  };
  try {
    for (const direction of ['inbound', 'outbound']) {
      const workflow = makeWorkflow();
      const call = {
        callSid: CALL_SID, user: USER_ID, provider: 'twilio',
        providerData: { workflowId: WORKFLOW_ID, direction, ...(direction === 'outbound' ? { to: CUSTOMER_A } : {}) }
      };
      const execution = { callSid: CALL_SID, userId: USER_ID, workflowId: WORKFLOW_ID };
      Workflow.default.findOne = () => query(workflow);
      Call.default.findOne = () => query(call);
      ExecutionLog.default.findOne = () => query(execution);
      WorkflowExecution.default.findOne = () => query(null);
      twilioIntegrationService.default.handleTransferComplete = async () => {};

      const socket = new EventEmitter();
      socket.readyState = 1;
      socket.sent = [];
      socket.send = (frame, callback) => { socket.sent.push(JSON.parse(frame)); callback?.(); };
      socket.close = () => {};
      const request = { url: `/ws/conversation-relay?userId=${USER_ID}&workflowId=${WORKFLOW_ID}&nodeId=${NODE_ID}` };
      await relayService.handleConnection(socket, request);
      await sendFrame(socket, { type: 'setup', callSid: CALL_SID, from: CUSTOMER_A });

      await sendFrame(socket, { type: 'prompt', voicePrompt: 'Enna services pandringa?', lang: 'ta-IN', last: true });
      assert.equal(socket.sent.at(-1)?.token,
        'நம்ம TechnovaHub-ல IT சர்வீசஸ், AI ஆட்டோமேஷன், டிஜிட்டல் டிரான்ஸ்ஃபர்மேஷன் சர்வீசஸ் எல்லாம் பண்ணிட்டு இருக்கோம்.');

      await sendFrame(socket, { type: 'prompt', voicePrompt: 'AI automation na enna?', lang: 'ta-IN', last: true });
      assert.equal(socket.sent.at(-1)?.token,
        'எங்களோட AI ஆட்டோமேஷன் சர்வீசஸ்க்கு சில ஸ்பெஷல் ஆஃபர்ஸ் இருக்கு. அதைப் பத்தி இன்னும் டீடெயிலா தெரிஞ்சிக்க உங்களை எங்க டீம் கூட கனெக்ட் பண்ணட்டுமா?');
      assert.equal(socket.sent.at(-1)?.type, 'text');
      assert.equal(socket.sent.some((frame) => frame.type === 'end'), false);

      await sendFrame(socket, { type: 'prompt', voicePrompt: 'Yes', lang: 'ta-IN', last: true });
      assert.equal(socket.sent.at(-2)?.token, 'சரி! ஒரு நிமிஷம் வெயிட் பண்ணுங்க. உங்களை எங்க டீம் கூட கனெக்ட் பண்றேன்.');
      assert.equal(JSON.parse(socket.sent.at(-1).handoffData).status, 'faq_transfer');

      const completionRoute = router.default.stack.find((layer) => layer.route?.path === '/ai-voice-agent/complete').route.stack[0].handle;
      const res = {
        sendStatus(code) { throw new Error(`Unexpected HTTP ${code}`); },
        type() { return this; },
        send(xml) { this.xml = xml; return this; }
      };
      await completionRoute({ body: { CallSid: CALL_SID, workflowId: WORKFLOW_ID, nodeId: NODE_ID,
        HandoffData: JSON.stringify({ status: 'faq_transfer', faqId: 'ai_automation' }) }, query: {} }, res);
      assert.match(res.xml, new RegExp(`<Number>${TEAM_B.replace('+', '\\+')}</Number>`));
      assert.doesNotMatch(res.xml, new RegExp(CUSTOMER_A.replace('+', '\\+')));

      const transferRoute = router.default.stack.find((layer) => layer.route?.path === '/transfer/complete').route.stack[0].handle;
      const transferRes = { sendStatus(code) { throw new Error(`Unexpected HTTP ${code}`); },
        type() { return this; }, send(xml) { this.xml = xml; return this; } };
      await transferRoute({ body: { CallSid: CALL_SID, DialCallStatus: 'completed', workflowId: WORKFLOW_ID,
        nodeId: NODE_ID }, query: {} }, transferRes);
      assert.match(transferRes.xml, /\/webhook\/twilio\/workflow\/workflow-test\/node\/end/);
    }
  } finally {
    Workflow.default.findOne = originals.workflow;
    Call.default.findOne = originals.call;
    ExecutionLog.default.findOne = originals.execution;
    WorkflowExecution.default.findOne = originals.legacy;
    twilioIntegrationService.default.handleTransferComplete = originals.transferComplete;
  }
});
