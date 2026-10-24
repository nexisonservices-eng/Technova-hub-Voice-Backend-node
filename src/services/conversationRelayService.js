import twilio from 'twilio';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import Workflow from '../models/Workflow.js';
import Call from '../models/call.js';
import ExecutionLog from '../models/ExecutionLog.js';
import adminCredentialsService from './adminCredentialsService.js';
import logger from '../utils/logger.js';
import { validateAgentConfig, resolveCallProvider } from '../config/conversationRelay.js';
import { createOrderedRelayFrameQueue } from './conversationRelayProtocol.js';
import { createFaqState, processFaqPrompt } from './conversationRelayFaq.js';
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
    let turnNumber = 0;
    let finished = false;
    let timer = null;
    let setupStage = 'tenant_authorization';
    let faqState = null;

    socket.on('close', (code, reason) => {
      clearTimeout(timer);
      logger.info('ConversationRelay websocket closed', {
        event: 'websocket_closed', connectionId, correlationId, stage: 'websocket_close', code,
        closeKind: code === 1006 ? 'abnormal_network_or_peer_close' : 'normal_or_protocol_close',
        reason: String(reason || '').slice(0, 120), durationMs: Date.now() - connectionStartedAt
      });
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
          if (relaySession?.setupReceived) {
            logger.warn('ConversationRelay duplicate setup event rejected', {
              connectionId, correlationId, stage: 'setup_validation', reason: 'setup_already_bound'
            });
            finished = true;
            safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'error', reason: 'duplicate-setup' }) });
            socket.close(1008, 'Duplicate ConversationRelay setup');
            return;
          }
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
          faqState = createFaqState(binding.callSid);
          logger.info('ConversationRelay FAQ session ready', {
            event: 'faq_session_ready', connectionId, correlationId,
            welcomeConfigured: true, stage: faqState.stage
          });
          return;
        }

        if (message.type === 'interrupt') {
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
        const currentTurn = ++turnNumber;
        const promptText = typeof message.voicePrompt === 'string' ? message.voicePrompt.trim() : '';
        logger.info('ConversationRelay prompt received', {
          event: 'prompt_received', connectionId, correlationId, turn: currentTurn,
          last: message.last === true, chars: promptText.length,
          language: String(message.lang || '').slice(0, 20) || null
        });
        if (message.last !== true) {
          logger.info('ConversationRelay partial prompt ignored by script state machine', {
            connectionId, correlationId, turn: currentTurn, stage: 'prompt_partial'
          });
          return;
        }
        if (finished) {
          logger.warn('ConversationRelay prompt ignored after session completion', { connectionId, correlationId, stage: 'prompt_after_end' });
          return;
        }

        if (!getRelaySessionCallSid(relaySession)) {
          logger.warn('ConversationRelay prompt received before a valid setup event', {
            connectionId, correlationId, stage: 'prompt_without_setup'
          });
          return;
        }
        const text = typeof message.voicePrompt === 'string' ? message.voicePrompt.trim().slice(0, 3000) : '';
        const transferAvailable = data.transferOnCustomerRequest !== false
          && /^\+[1-9]\d{7,14}$/.test(String(data.humanAgentPhoneNumber || '').trim());
        const result = processFaqPrompt(faqState, text, { transferAvailable });
        logger.info('ConversationRelay FAQ prompt matched', {
          event: 'faq_matched', connectionId, correlationId, turn: currentTurn,
          faqId: result.faqId || null, action: result.action,
          chars: text.length
        });
        if (result.action === 'answer') {
          const sent = safeSend(socket, {
            type: 'text', token: result.answer, lang: 'ta-IN', last: true,
            interruptible: true, preemptible: false
          });
          logger.info('ConversationRelay FAQ response sent', {
            event: 'response_sent', connectionId, correlationId, turn: currentTurn,
            faqId: result.faqId, chars: result.answer.length, sent
          });
        } else if (result.action === 'transfer') {
          logger.info('ConversationRelay FAQ transfer requested', {
            event: 'transfer_requested', connectionId, correlationId,
            turn: currentTurn, faqId: result.faqId
          });
          finished = true;
          safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'faq_transfer' }) });
        } else if (result.action === 'end') {
          finished = true;
          safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'faq_goodbye' }) });
        }
      } catch (error) {
        logger.error('ConversationRelay message handler failed', {
          connectionId, correlationId, stage: 'message_handler', errorType: error?.name || 'Error'
        });
        if (getRelaySessionCallSid(relaySession) && !finished) {
          finished = true;
          safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'faq_goodbye' }) });
        }
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
      logger.info('ConversationRelay websocket accepted', {
        connectionId, correlationId
      });
      setupStage = 'tenant_authorization';
      const workflow = await Workflow.findOne({ _id: workflowId, createdBy: userId }).lean();
      const node = workflow?.nodes?.find((entry) => entry.id === nodeId && entry.type === 'ai_voice_agent');
      if (!node) throw new Error('AI Voice Agent workflow node was not found for this tenant');
      data = node.data || {};
      setupStage = 'agent_configuration';
      validateAgentConfig(data);
      relaySession = createRelaySessionContext({ userId, workflowId, nodeId });
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
      logger.info('ConversationRelay FAQ call reached its maximum duration', {
        event: 'call_ended', connectionId, correlationId, stage: 'duration_limit',
        reason: 'duration-limit', durationSeconds: Number(data.maxDuration || 300)
      });
      safeSend(socket, { type: 'end', handoffData: JSON.stringify({ status: 'completed', reason: 'duration-limit' }) });
    }, Number(data.maxDuration || 300) * 1000);
    timer.unref?.();

    if (socket.readyState === WebSocket.OPEN) frameQueue.activate();
  }
}

export default new ConversationRelayService();
