import axios from 'axios';
import twilio from 'twilio';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import Workflow from '../models/Workflow.js';
import Call from '../models/call.js';
import ExecutionLog from '../models/ExecutionLog.js';
import adminCredentialsService from './adminCredentialsService.js';
import logger from '../utils/logger.js';
import { validateAgentConfig, resolveCallProvider } from '../config/conversationRelay.js';
import { describeConversationAIEndpoint, resolveConversationAIBaseUrl } from '../config/conversationAIUrl.js';
import { buildAiFailureMessage, createOrderedRelayFrameQueue, processRelayPrompt } from './conversationRelayProtocol.js';
import {
  bindRelaySetupCallSid,
  createRelaySessionContext,
  getRelaySessionCallSid
} from './conversationRelaySession.js';

export { validateAgentConfig };

export const verifyRelayUpgrade = async (req) => {
  try {
    const parsed = new URL(req.url, 'https://localhost');
    if (parsed.pathname !== '/ws/conversation-relay') return false;
    const userId = String(parsed.searchParams.get('userId') || '').trim();
    const workflowId = String(parsed.searchParams.get('workflowId') || '').trim();
    const nodeId = String(parsed.searchParams.get('nodeId') || '').trim();
    const connectionId = req.relayConnectionId || '';
    if (!userId || !workflowId || !nodeId) {
      logger.warn('ConversationRelay upgrade rejected: required tenant routing fields are missing', {
        connectionId, stage: 'tenant_routing_validation'
      });
      return false;
    }
    const credential = await adminCredentialsService.getTwilioCredentialsByUserId(userId);
    const signature = req.headers['x-twilio-signature'];
    if (!credential?.twilioAuthToken || !signature) {
      logger.warn('ConversationRelay upgrade rejected: tenant credentials or Twilio signature are unavailable', {
        connectionId, stage: 'signature_prerequisite'
      });
      return false;
    }
    const base = String(process.env.PUBLIC_WEBHOOK_BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '');
    if (!/^https:\/\//i.test(base)) {
      logger.warn('ConversationRelay upgrade rejected: public HTTPS base URL is unavailable', {
        connectionId, stage: 'signature_url_configuration'
      });
      return false;
    }
    const signedUrl = `${base.replace(/^https:/i, 'wss:')}${req.url}`;
    const valid = twilio.validateRequest(credential.twilioAuthToken, signature, signedUrl, {});
    if (!valid) logger.warn('ConversationRelay upgrade rejected: invalid Twilio signature', { connectionId, stage: 'signature_validation' });
    else logger.info('ConversationRelay Twilio signature validated', { connectionId, stage: 'signature_validation' });
    return valid;
  } catch (error) {
    logger.warn('ConversationRelay signature validation failed', { stage: 'signature_validation', errorType: error?.name || 'Error' });
    return false;
  }
};

const safeSend = (socket, payload) => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload), (error) => {
      if (error) logger.warn('ConversationRelay websocket send failed', { errorType: error.name || 'Error' });
    });
    return true;
  } catch (error) {
    logger.warn('ConversationRelay websocket send failed', { errorType: error?.name || 'Error' });
    return false;
  }
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
    const connectionId = req.relayConnectionId || randomUUID();
    let correlationId = connectionId;
    const connectionStartedAt = Date.now();
    let data = null;
    let relaySession = null;
    let callGeneration = 0;
    let finished = false;
    let timer = null;
    let setupStage = 'python_ai_configuration';
    const state = { discountAsked: false, waitingForMoreHelp: false, discountQuestion: '' };

    socket.on('close', (code, reason) => {
      clearTimeout(timer);
      logger.info('ConversationRelay websocket closed', {
        connectionId, correlationId, stage: 'websocket_close', code,
        closeKind: code === 1006 ? 'abnormal_network_or_peer_close' : 'normal_or_protocol_close',
        reason: String(reason || '').slice(0, 120), durationMs: Date.now() - connectionStartedAt
      });
      const callSid = getRelaySessionCallSid(relaySession);
      if (callSid) {
        void (async () => {
          try {
            const aiBaseUrl = resolveConversationAIBaseUrl();
            const headers = { 'X-Correlation-ID': correlationId };
            if (process.env.PYTHON_API_KEY) headers['X-API-Key'] = process.env.PYTHON_API_KEY;
            await axios.post(`${aiBaseUrl}/reset-conversation/${encodeURIComponent(callSid)}`, {}, { timeout: 3000, headers });
          } catch (error) {
            logger.warn('Unable to clear AI conversation memory after relay close', {
              connectionId, correlationId, stage: 'conversation_reset', errorType: error?.name || 'Error',
              status: error?.response?.status || null
            });
          }
        })();
      }
    });
    socket.on('error', (error) => logger.warn('ConversationRelay websocket error', {
      connectionId, correlationId, stage: 'websocket_error', errorType: error?.name || 'Error', code: error?.code || null
    }));

    const processMessage = async (raw) => {
      try {
        let message;
        try { message = JSON.parse(raw.toString()); } catch {
          logger.warn('ConversationRelay received malformed message', { connectionId, correlationId, stage: 'message_parse' });
          return;
        }
        logger.info('ConversationRelay event received', {
          connectionId, correlationId, eventType: String(message?.type || 'unknown').slice(0, 40)
        });

        if (message.type === 'setup') {
          const candidateCallSid = String(message.callSid || message.CallSid || '').trim();
          let execution = null;
          let call = null;
          try {
            if (candidateCallSid) {
              [execution, call] = await Promise.all([
                ExecutionLog.findOne({ callSid: candidateCallSid }).select('callSid userId workflowId').lean(),
                Call.findOne({ callSid: candidateCallSid }).select('callSid user provider providerData').lean()
              ]);
            }
          } catch (error) {
            logger.error('ConversationRelay setup association lookup failed', {
              connectionId, correlationId, stage: 'setup_association_lookup',
              errorType: error?.name || 'Error'
            });
            finished = true;
            safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'error', reason: 'session-validation' }) });
            socket.close(1011, 'Session validation failed');
            return;
          }
          const binding = bindRelaySetupCallSid(relaySession, message, { execution, call });
          if (!binding.valid) {
            logger.warn('ConversationRelay setup event rejected', {
              connectionId, correlationId, stage: 'setup_validation', reason: binding.reason
            });
            finished = true;
            safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'error', reason: 'invalid-session' }) });
            socket.close(1008, 'Invalid ConversationRelay setup');
            return;
          }

          correlationId = binding.callSid;
          const provider = call ? resolveCallProvider(call) || 'unknown' : 'twilio_execution_record';
          logger.info('ConversationRelay setup event authenticated', {
            connectionId, correlationId, provider, language: data.language,
            sessionIdPresent: Boolean(message.sessionId), stage: 'setup'
          });
          return;
        }

        if (message.type === 'interrupt') {
          callGeneration += 1;
          logger.info('ConversationRelay caller interrupted agent speech', { connectionId, correlationId, stage: 'interrupt' });
          return;
        }
        if (message.type === 'error') {
          logger.warn('Twilio ConversationRelay reported an error', {
            connectionId, correlationId, stage: 'relay_error', code: String(message.code || '').slice(0, 40) || null,
            descriptionChars: String(message.description || '').length
          });
          return;
        }
        if (message.type !== 'prompt') return;
        if (finished) {
          logger.warn('ConversationRelay prompt ignored after session completion', { connectionId, correlationId, stage: 'prompt_after_end' });
          return;
        }

        const sessionCallSid = getRelaySessionCallSid(relaySession);
        const promptCallSid = String(message.callSid || message.CallSid || '').trim();
        if (promptCallSid) {
          logger.warn('ConversationRelay prompt CallSid field ignored; using authenticated setup identity', {
            connectionId, correlationId, stage: 'prompt_identity_ignored', matchesSession: promptCallSid === sessionCallSid
          });
        }
        if (!sessionCallSid) {
          logger.warn('ConversationRelay prompt received before a valid setup event', {
            connectionId, correlationId, stage: 'prompt_without_setup'
          });
        }

        const generation = ++callGeneration;
        const startedAt = Date.now();
        if (message.lang && message.lang !== data.language) {
          logger.warn('ConversationRelay prompt language differs from configured language', {
            connectionId, correlationId, stage: 'language_mismatch', promptLanguage: String(message.lang).slice(0, 20),
            configuredLanguage: data.language
          });
        }
        const turn = await processRelayPrompt({
          message,
          callSid: sessionCallSid,
          isCurrent: () => !finished && generation === callGeneration,
          requestAI: async (text, promptMessage) => {
            const aiBaseUrl = resolveConversationAIBaseUrl();
            const headers = { 'X-Correlation-ID': correlationId };
            if (process.env.PYTHON_API_KEY) headers['X-API-Key'] = process.env.PYTHON_API_KEY;
            logger.info('ConversationRelay forwarding transcript to Python AI', {
              connectionId, correlationId, stage: 'python_request', language: promptMessage.lang || data.language,
              chars: text.length, endpoint: describeConversationAIEndpoint(`${aiBaseUrl}/conversation-turn`)
            });
            const { data: result } = await axios.post(`${aiBaseUrl}/conversation-turn`, {
              text,
              call_id: sessionCallSid,
              system_prompt: buildPrompt(data),
              conversation_state: state
            }, { timeout: 35000, headers });
            return result;
          },
          shouldTransfer: (result) => intentTransfer(result, state, data),
          onAIResult: (result) => {
            const intent = String(result.intent || 'continue').toLowerCase();
            if (intent === 'offer_discounts' && !state.discountAsked) state.discountAsked = true;
            if (intent === 'discount_no') state.waitingForMoreHelp = true;
          },
          send: (payload) => safeSend(socket, payload),
          onStage: (stage, fields = {}) => logger.info(`ConversationRelay ${stage}`, {
            connectionId, correlationId, stage, durationMs: Date.now() - startedAt, ...fields
          })
        });
        if (turn.status === 'transfer' || turn.status === 'end') finished = true;
      } catch (error) {
        logger.error('ConversationRelay message handler failed', {
          connectionId, correlationId, stage: 'message_handler', errorType: error?.name || 'Error'
        });
        if (getRelaySessionCallSid(relaySession) && !finished) safeSend(socket, buildAiFailureMessage());
      }
    };

    // Twilio sends `setup` immediately after the handshake. Attach the listener
    // now, and buffer/serialize frames until tenant workflow authorization ends.
    const frameQueue = createOrderedRelayFrameQueue(processMessage, 32, (error) => {
      logger.error('ConversationRelay serialized message queue failed', {
        connectionId, correlationId, stage: 'message_queue', errorType: error?.name || 'Error'
      });
    });
    socket.on('message', (raw) => {
      const result = frameQueue.enqueue(raw);
      if (result.overflow) {
        logger.warn('ConversationRelay pre-authorization frame queue limit reached', {
          connectionId, correlationId, stage: 'preauthorization_queue_limit'
        });
        socket.close(1008, 'Too many early messages');
      } else if (result.buffered) {
        logger.info('ConversationRelay frame buffered pending workflow authorization', {
          connectionId, correlationId, stage: 'preauthorization_buffer', queuedFrames: result.buffered
        });
      }
    });

    try {
      const aiBaseUrl = resolveConversationAIBaseUrl();
      logger.info('ConversationRelay websocket accepted', {
        connectionId, correlationId, aiEndpoint: describeConversationAIEndpoint(`${aiBaseUrl}/conversation-turn`),
        pythonApiKeyConfigured: Boolean(process.env.PYTHON_API_KEY)
      });
      setupStage = 'tenant_authorization';
      const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId }).lean();
      const node = workflow?.nodes?.find((entry) => entry.id === nodeId && entry.type === 'ai_voice_agent');
      if (!node) throw new Error('AI Voice Agent workflow node was not found for this tenant');
      data = node.data || {};
      setupStage = 'agent_configuration';
      validateAgentConfig(data);
      relaySession = createRelaySessionContext({ userId, workflowId, nodeId });
      state.discountQuestion = String(data.discountQuestion || '').slice(0, 500);
      logger.info('ConversationRelay tenant workflow authorized', {
        connectionId, correlationId, language: data.language, voice: data.voiceSelection
      });
    } catch (error) {
      logger.error('ConversationRelay setup failed', {
        connectionId, correlationId, stage: setupStage, errorType: error?.name || 'Error'
      });
      safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'error', reason: 'configuration' }) });
      socket.close(1011, 'Configuration error');
      return;
    }

    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      logger.info('ConversationRelay maximum duration reached', { connectionId, correlationId, stage: 'duration_limit' });
      safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'completed', reason: 'duration-limit' }) });
    }, Number(data.maxDuration || 300) * 1000);
    timer.unref?.();

    if (socket.readyState === WebSocket.OPEN) frameQueue.activate();
  }
}

export default new ConversationRelayService();
