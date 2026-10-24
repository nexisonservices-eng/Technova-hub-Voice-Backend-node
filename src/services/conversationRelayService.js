import axios from 'axios';
import twilio from 'twilio';
import WebSocket from 'ws';
import Workflow from '../models/Workflow.js';
import adminCredentialsService from './adminCredentialsService.js';
import logger from '../utils/logger.js';
import { validateAgentConfig } from '../config/conversationRelay.js';

const AI_URL = (process.env.AI_SERVICE_HTTP || 'http://localhost:4000').replace(/\/$/, '');
export { validateAgentConfig };

export const verifyRelayUpgrade = async (req) => {
  try {
    const parsed = new URL(req.url, 'https://localhost');
    if (parsed.pathname !== '/ws/conversation-relay') return false;
    const userId = String(parsed.searchParams.get('userId') || '').trim();
    const workflowId = String(parsed.searchParams.get('workflowId') || '').trim();
    const nodeId = String(parsed.searchParams.get('nodeId') || '').trim();
    if (!userId || !workflowId || !nodeId) return false;
    const credential = await adminCredentialsService.getTwilioCredentialsByUserId(userId);
    const signature = req.headers['x-twilio-signature'];
    if (!credential?.twilioAuthToken || !signature) return false;
    const base = String(process.env.PUBLIC_WEBHOOK_BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '');
    if (!/^https:\/\//i.test(base)) return false;
    const signedUrl = `${base.replace(/^https:/i, 'wss:')}${req.url}`;
    const valid = twilio.validateRequest(credential.twilioAuthToken, signature, signedUrl, {});
    if (!valid) logger.warn('ConversationRelay upgrade rejected: invalid Twilio signature', { userId, workflowId, nodeId });
    return valid;
  } catch (error) {
    logger.warn('ConversationRelay signature validation failed', { message: error.message });
    return false;
  }
};

const safeSend = (socket, payload) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
};

const intentTransfer = (result, state, data) => {
  const intent = String(result.intent || '').toLowerCase();
  if (intent === 'human_transfer') return data.transferOnCustomerRequest !== false;
  if (intent === 'discount_yes') return data.transferOnDiscountInterest !== false && state.discountAsked;
  return false;
};

const buildPrompt = (data) => [
  `You are the conversational voice agent for ${data.companyName}.`,
  `Reply in the configured call language ${data.language}. Never translate customer content unless asked.`,
  String(data.systemPrompt || ''),
  `Business information:\n${String(data.knowledgeBase || '')}`,
  `If the caller asks about a discount, rebate, coupon, or price reduction, ask exactly this question once and classify that turn as offer_discounts: ${String(data.discountQuestion || '')}`,
  data.transferOnDiscountInterest === false
    ? 'If they express interest in a discount, classify as discount_yes and continue assisting; do not claim a transfer will happen.'
    : 'If they express interest in a discount, classify as discount_yes so the system can connect them with the configured agent.',
  data.transferOnCustomerRequest === false
    ? 'If they ask for a human, politely explain a live transfer is unavailable and continue helping; do not classify as human_transfer.'
    : 'If they ask for a human, classify as human_transfer so the system can connect them with the configured agent.',
  'If they decline the discount, classify as discount_no.',
  'Classify every turn as one of: continue, offer_discounts, discount_yes, discount_no, human_transfer, end_call, clarify.',
  'Never invent company facts.'
].join('\n\n');

class ConversationRelayService {
  async handleConnection(socket, req) {
    const parsed = new URL(req.url, 'https://localhost');
    const userId = parsed.searchParams.get('userId');
    const workflowId = parsed.searchParams.get('workflowId');
    const nodeId = parsed.searchParams.get('nodeId');
    let data = null;
    let callSid = '';
    let callGeneration = 0;
    let finished = false;
    let timer = null;
    const state = { discountAsked: false, waitingForMoreHelp: false, discountQuestion: '' };

    try {
      const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId }).lean();
      const node = workflow?.nodes?.find((entry) => entry.id === nodeId && entry.type === 'ai_voice_agent');
      if (!node) throw new Error('AI Voice Agent workflow node was not found for this tenant');
      data = node.data || {};
      validateAgentConfig(data);
      state.discountQuestion = String(data.discountQuestion || '').slice(0, 500);
      logger.info('ConversationRelay connected', { userId, workflowId, nodeId, language: data.language, voice: data.voiceSelection });
    } catch (error) {
      logger.error('ConversationRelay setup failed', { userId, workflowId, nodeId, message: error.message });
      safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'error', reason: 'configuration' }) });
      socket.close(1011, 'Configuration error');
      return;
    }

    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      logger.info('ConversationRelay maximum duration reached', { workflowId, nodeId, callSid });
      safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'completed', reason: 'duration-limit' }) });
    }, Number(data.maxDuration || 300) * 1000);
    timer.unref?.();

    socket.on('message', async (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { logger.warn('ConversationRelay received malformed message'); return; }
      if (message.type === 'setup') {
        callSid = String(message.callSid || '').slice(0, 100);
        return;
      }
      if (message.type === 'interrupt') {
        callGeneration += 1;
        return;
      }
      if (message.type === 'error') {
        logger.warn('Twilio ConversationRelay reported an error', { callSid, code: message.code || null });
        return;
      }
      if (message.type !== 'prompt' || message.last === false || finished) return;
      const text = String(message.voicePrompt || '').trim();
      if (!text || !callSid) {
        logger.warn('ConversationRelay prompt ignored: missing final text or CallSid', { callSid });
        return;
      }
      const generation = ++callGeneration;
      logger.info('ConversationRelay caller turn received', { callSid, language: data.language, chars: text.length });
      try {
        const headers = {};
        if (process.env.PYTHON_API_KEY) headers['X-API-Key'] = process.env.PYTHON_API_KEY;
        const { data: result } = await axios.post(`${AI_URL}/conversation-turn`, {
          text,
          call_id: callSid,
          system_prompt: buildPrompt(data),
          conversation_state: state
        }, { timeout: 30000, headers });
        if (finished || generation !== callGeneration) return;
        const answer = String(result?.response || '').trim();
        if (!answer) throw new Error('AI service returned an empty response');
        const intent = String(result.intent || 'continue').toLowerCase();
        const spokenAnswer = answer;
        if (intent === 'offer_discounts' && !state.discountAsked) {
          state.discountAsked = true;
        }
        if (intent === 'discount_no') state.waitingForMoreHelp = true;
        if (intentTransfer(result, state, data)) {
          finished = true;
          logger.info('ConversationRelay handing off to configured human agent', { callSid, intent });
          safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'transfer', intent }) });
          return;
        }
        if (intent === 'end_call') {
          finished = true;
          safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'completed', reason: 'customer-ended' }) });
          return;
        }
        safeSend(socket, { type: 'text', token: spokenAnswer, last: true, interruptible: true });
        logger.info('ConversationRelay response generated', { callSid, intent, chars: spokenAnswer.length });
      } catch (error) {
        logger.error('ConversationRelay AI turn failed', { callSid, message: error.message, status: error.response?.status || null });
        if (generation === callGeneration && socket.readyState === WebSocket.OPEN) {
          safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'error', reason: 'ai-service' }) });
          finished = true;
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(timer);
      if (callSid) {
        const headers = process.env.PYTHON_API_KEY ? { 'X-API-Key': process.env.PYTHON_API_KEY } : {};
        void axios.post(`${AI_URL}/reset-conversation/${encodeURIComponent(callSid)}`, {}, { timeout: 3000, headers })
          .catch(() => logger.warn('Unable to clear AI conversation memory after relay close', { callSid }));
      }
    });
    socket.on('error', (error) => logger.warn('ConversationRelay websocket error', { callSid, message: error.message }));
  }
}

export default new ConversationRelayService();
