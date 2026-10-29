import twilio from 'twilio';
import WebSocket from 'ws';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import Workflow from '../models/Workflow.js';
import Call from '../models/call.js';
import ExecutionLog from '../models/ExecutionLog.js';
import adminCredentialsService from './adminCredentialsService.js';
import logger from '../utils/logger.js';
import { validateAgentConfig, resolveCallProvider } from '../config/conversationRelay.js';
import { createOrderedRelayFrameQueue } from './conversationRelayProtocol.js';
import { multilingualIntentEnabled, resolveConversationRelayIntent, intentDiagnostic } from './conversationRelayIntent.js';
import groqIntentService from './conversationRelayGroq.js';
import {
  FAQ_ENTRIES,
  FAQ_RESPONSES,
  createFaqState,
  extractConversationRelayTranscription,
  normalizeFaqQuestion,
  matchFaq,
  classifyConfirmation,
  processFaqPrompt,
  deliverConversationRelayFaqResult,
  isClearTransferConfirmation,
  redactFaqDiagnosticText
} from './conversationRelayFaq.js';
import conversationRelayOpenAI from './conversationRelayOpenAI.js';
import { OPENAI_HISTORY_LIMIT, OPENAI_SPOKEN_FALLBACK } from './conversationRelayOpenAI.js';
import { resolveConnectedHandoffDestination } from './conversationRelayTransfer.js';
import {
  bindRelaySetupCallSid,
  createRelaySessionContext,
  getRelaySessionCallSid
} from './conversationRelaySession.js';

export { validateAgentConfig };

const handlerInstanceId = randomUUID();
const diagnosticVersion = 'relay_first_speech_v2';
const faqConfigurationHash = createHash('sha256').update(JSON.stringify(FAQ_ENTRIES)).digest('hex');
const snapshotFaqState = (state) => ({
  faqReady: Boolean(state), stage: state?.stage || null, turns: state?.turns || 0,
  awaitingHumanConfirmation: state?.awaitingHumanConfirmation === true,
  awaitingAutomationConfirmation: state?.awaitingAutomationConfirmation === true
});
const FAQ_DIAGNOSTIC_WORDS = new Set([
  'enna', 'services', 'service', 'pandringa', 'panringa', 'pandreenga', 'panreenga', 'pannum', 'panum',
  'neenga', 'unga', 'company', 'what', 'do', 'you', 'offer', 'ai', 'automation', 'na', 'meaning', 'is',
  'என்ன', 'சர்வீசஸ்', 'சர்வீஸ்', 'பண்றீங்க', 'பண்ணுறீங்க', 'நீங்க', 'உங்க', 'நிறுவனம்', 'செய்யும்',
  'ஏஐ', 'ஆட்டோமேஷன்'
]);
const safeFaqDiagnosticTranscript = (value) => {
  const tokens = String(value || '').normalize('NFKC').match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  return tokens.map((token) => FAQ_DIAGNOSTIC_WORDS.has(token.toLowerCase()) ? token : '[redacted]')
    .join(' ').slice(0, 180);
};

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

const safeSend = (socket, payload, onWrite = () => {}) => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload), (error) => {
      onWrite(error || null);
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
    let workflowConfig = null;
    let relaySession = null;
    let turnNumber = 0;
    let customerTurnNumber = 0;
    let finished = false;
    let timer = null;
    let setupStage = 'tenant_authorization';
    let faqState = null;
    // Connection-local context: one WebSocket belongs to one authenticated call.
    const conversationHistory = [];
    let frameSequence = 0;
    let outboundSequence = 0;
    let previousFinalFingerprint = null;
    let previousFinalAt = null;
    // Snapshot per call; changing the environment cannot alter an active call.
    const nlpEnabled = multilingualIntentEnabled();
    // Log only allowlisted FAQ vocabulary; names, numbers, and unrelated words
    // are replaced before transcript diagnostics leave this handler.
    const diagnosticText = safeFaqDiagnosticTranscript;
    // Per-connection keyed fingerprints compare repeated speech without adding
    // transcript content or reusable hashes of customer speech to diagnostics.
    const fingerprintKey = randomUUID();
    const fingerprint = (text) => createHmac('sha256', fingerprintKey).update(text).digest('hex');
    const trace = (event, fields = {}) => logger.info('ConversationRelay diagnostic', {
      event, diagnosticVersion, handlerInstanceId, connectionId, correlationId,
      elapsedMs: Date.now() - connectionStartedAt, ...fields
    });
    const sendFrame = (payload, context = {}) => {
      const outboundFrame = ++outboundSequence;
      const answerKey = payload.type === 'text'
        ? FAQ_ENTRIES.find(({ answer }) => answer === payload.token)?.id
          || Object.entries(FAQ_RESPONSES).find(([, answer]) => answer === payload.token)?.[0]
          || 'unmapped_text'
        : null;
      const fields = {
        ...context, outboundFrame, frameType: payload.type,
        ...(payload.type === 'text' ? {
          answerKey, chars: String(payload.token || '').length,
          ...(['openai', 'openai_fallback'].includes(context.responseSource)
            ? {} : { speechText: redactFaqDiagnosticText(payload.token) })
        } : {})
      };
      // A write callback confirms a local WebSocket write, not audible playback.
      trace('relay_output_attempt', fields);
      const accepted = safeSend(socket, payload, (error) => trace('relay_output_write', {
        ...fields, written: !error, errorType: error?.name || null
      }));
      trace('relay_output_enqueued', { ...fields, accepted });
      return accepted;
    };
    const rememberTurn = (userText, assistantText) => {
      conversationHistory.push(
        { role: 'user', content: String(userText || '').slice(0, 3000) },
        { role: 'assistant', content: String(assistantText || '').slice(0, 850) }
      );
      if (conversationHistory.length > OPENAI_HISTORY_LIMIT) {
        conversationHistory.splice(0, conversationHistory.length - OPENAI_HISTORY_LIMIT);
      }
    };

    socket.on('close', (code, reason) => {
      clearTimeout(timer);
      conversationHistory.length = 0;
      logger.info('ConversationRelay websocket closed', {
        event: 'websocket_closed', connectionId, correlationId, stage: 'websocket_close', code,
        closeKind: code === 1006 ? 'abnormal_network_or_peer_close' : 'normal_or_protocol_close',
        reason: String(reason || '').slice(0, 120), durationMs: Date.now() - connectionStartedAt
      });
      trace('relay_session_summary', {
        receivedFrames: frameSequence, promptFrames: turnNumber,
        customerTurns: customerTurnNumber, outboundFrames: outboundSequence,
        finished, ...snapshotFaqState(faqState)
      });
    });
    socket.on('error', (error) => logger.warn('ConversationRelay websocket error', {
      connectionId, correlationId, stage: 'websocket_error', errorType: error?.name || 'Error', code: error?.code || null
    }));

    const processMessage = async ({ raw, sequence, receivedAt }) => {
      try {
        let message;
        try { message = JSON.parse(raw.toString()); } catch {
          logger.warn('ConversationRelay received malformed message', { connectionId, correlationId, stage: 'message_parse' });
          return;
        }
        logger.info('ConversationRelay event received', {
          connectionId, correlationId, eventType: String(message?.type || 'unknown').slice(0, 40)
        });
        trace('relay_frame_processing', {
          frameSequence: sequence, eventType: String(message?.type || 'unknown').slice(0, 40),
          receivedAtUtc: new Date(receivedAt).toISOString(), queueWaitMs: Date.now() - receivedAt,
          ...snapshotFaqState(faqState), finished
        });

        if (message.type === 'setup') {
          if (relaySession?.setupReceived) {
            logger.warn('ConversationRelay duplicate setup event rejected', {
              connectionId, correlationId, stage: 'setup_validation', reason: 'setup_already_bound'
            });
            finished = true;
            sendFrame({ type: 'end', handoffData: JSON.stringify({ status: 'error', reason: 'duplicate-setup' }) });
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
            sendFrame({ type: 'end', handoffData: JSON.stringify({ status: 'error', reason: 'session-validation' }) });
            socket.close(1011, 'Session validation failed');
            return;
          }
          const binding = bindRelaySetupCallSid(relaySession, message, { execution, call });
          if (!binding.valid) {
            logger.warn('ConversationRelay setup event rejected', {
              connectionId, correlationId, stage: 'setup_validation', reason: binding.reason
            });
            finished = true;
            sendFrame({ type: 'end', handoffData: JSON.stringify({ status: 'error', reason: 'invalid-session' }) });
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
          logger.info('ConversationRelay FAQ configuration ready', {
            event: 'faq_configuration_ready', connectionId, correlationId,
            faqCount: FAQ_ENTRIES.length, workflowId, nodeId,
            stage: faqState.stage, awaitingHumanConfirmation: false,
            awaitingAutomationConfirmation: false, handler: 'node_predefined_faq_v1'
          });
          logger.info('ConversationRelay FAQ session ready', {
            event: 'faq_session_ready', connectionId, correlationId,
            welcomeConfigured: true, stage: faqState.stage
          });
          return;
        }

        if (message.type === 'interrupt') {
          trace('relay_interruption', {
            frameSequence: sequence,
            durationUntilInterruptMs: Number.isFinite(message.durationUntilInterruptMs)
              ? message.durationUntilInterruptMs : null,
            interruptedTextChars: typeof message.utteranceUntilInterrupt === 'string'
              ? message.utteranceUntilInterrupt.length : 0,
            ...snapshotFaqState(faqState)
          });
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
        if (message.type !== 'prompt') {
          trace('relay_event_not_routed', { frameSequence: sequence, reason: 'non_prompt_event' });
          return;
        }
        const currentTurn = ++turnNumber;
        const promptText = extractConversationRelayTranscription(message);
        logger.info('ConversationRelay prompt received', {
          event: 'prompt_received', connectionId, correlationId, turn: currentTurn,
          last: message.last === true, chars: promptText.length,
          receivedTranscription: diagnosticText(promptText),
          language: String(message.lang || '').slice(0, 20) || null
        });
        const normalizedPrompt = normalizeFaqQuestion(promptText);
        const promptDiagnostic = {
          frameSequence: sequence, turn: currentTurn,
          last: typeof message.last === 'boolean' ? message.last : null,
          lastFieldType: typeof message.last,
          voicePromptFieldType: typeof message.voicePrompt,
          rawChars: typeof message.voicePrompt === 'string' ? message.voicePrompt.length : 0,
          normalizedChars: normalizedPrompt.length,
          transcriptFingerprint: fingerprint(promptText), normalizedFingerprint: fingerprint(normalizedPrompt),
          candidateFaqId: matchFaq(promptText)?.id || null,
          ...snapshotFaqState(faqState), finished
        };
        const routeDecision = (reason) => trace('relay_prompt_disposition', { ...promptDiagnostic, reason });
        logger.info('ConversationRelay prompt normalized', {
          event: 'normalized_prompt', connectionId, correlationId, turn: currentTurn,
          normalizedTranscription: diagnosticText(normalizedPrompt)
        });
        logger.info('ConversationRelay transcription received', {
          event: 'transcription_received', connectionId, correlationId, turn: currentTurn,
          final: message.last === true, chars: promptText.length,
          transcription: diagnosticText(promptText)
        });
        logger.info('ConversationRelay transcription normalized', {
          event: 'normalized_transcription', connectionId, correlationId, turn: currentTurn,
          transcription: diagnosticText(normalizedPrompt)
        });
        if (message.last !== true) {
          routeDecision(message.last === false ? 'partial_waiting_for_final' : 'invalid_last_flag');
          logger.info('ConversationRelay partial prompt ignored by script state machine', {
            connectionId, correlationId, turn: currentTurn, stage: 'prompt_partial'
          });
          return;
        }
        if (finished) {
          routeDecision('session_finished');
          logger.warn('ConversationRelay prompt ignored after session completion', { connectionId, correlationId, stage: 'prompt_after_end' });
          return;
        }

        if (!getRelaySessionCallSid(relaySession)) {
          routeDecision('setup_not_authenticated');
          logger.warn('ConversationRelay prompt received before a valid setup event', {
            connectionId, correlationId, stage: 'prompt_without_setup'
          });
          return;
        }
        // An empty/noise-only final frame is not a customer question. In
        // particular, it must not create a handoff offer just after the welcome.
        if (!normalizedPrompt) {
          routeDecision('empty_normalized_final');
          logger.info('ConversationRelay empty final transcription ignored', {
            event: 'fallback_reason', connectionId, correlationId, turn: currentTurn,
            reason: 'empty_final_transcription_ignored', fallbackSent: false
          });
          return;
        }
        const normalizedFingerprint = promptDiagnostic.normalizedFingerprint;
        customerTurnNumber += 1;
        routeDecision('routed_to_faq');
        const stateBefore = snapshotFaqState(faqState);
        trace('relay_faq_input', {
          ...promptDiagnostic, customerTurn: customerTurnNumber, stateBefore,
          confirmation: classifyConfirmation(promptText),
          sameAsPreviousFinal: normalizedFingerprint === previousFinalFingerprint,
          sincePreviousFinalMs: previousFinalAt === null ? null : receivedAt - previousFinalAt
        });
        previousFinalFingerprint = normalizedFingerprint;
        previousFinalAt = receivedAt;
        if (customerTurnNumber === 1) {
          logger.info('ConversationRelay first customer turn received', {
            event: 'first_turn_received', connectionId, correlationId, turn: currentTurn,
            customerTurn: customerTurnNumber, faqReady: Boolean(faqState),
            stage: faqState.stage, awaitingHumanConfirmation: faqState.awaitingHumanConfirmation,
            awaitingAutomationConfirmation: faqState.awaitingAutomationConfirmation
          });
        }
        const text = promptText;
        const transferDestination = resolveConnectedHandoffDestination(workflowConfig, nodeId);
        const transferAvailable = data.transferOnCustomerRequest !== false
          && /^\+[1-9]\d{7,14}$/.test(String(transferDestination.destination || '').trim());
        const deterministicRecognition = resolveConversationRelayIntent(text, {
          enabled: nlpEnabled, providerLanguage: message.lang
        });
        trace('relay_deterministic_intent', {
          featureFlagEnabled: nlpEnabled,
          faqId: deterministicRecognition.faq?.id || null,
          intent: deterministicRecognition.intent || deterministicRecognition.faq?.intent || null,
          classification: deterministicRecognition.classification || null,
          confidence: deterministicRecognition.confidence ?? null,
          strategy: deterministicRecognition.strategy || (deterministicRecognition.faq ? 'legacy_faq_match' : null),
          reason: deterministicRecognition.reason
        });
        let groqRecognition;
        try {
          groqRecognition = await groqIntentService.classifyUnmatchedQuestionWithGroq(
            text, deterministicRecognition
          );
        } catch {
          // Keep the existing FAQ fallback safe if the optional classifier
          // itself fails before it can convert a provider error to a status.
          groqRecognition = {
            attempted: true, status: 'request_failed', faq: null,
            intent: null, confidence: null, model: null, failureKind: 'classifier_error'
          };
        }
        trace('relay_groq_fallback', {
          enabled: process.env.GROQ_NLP_ENABLED === 'true',
          attempted: groqRecognition.attempted,
          status: groqRecognition.status,
          intent: groqRecognition.intent,
          confidence: groqRecognition.confidence,
          model: groqRecognition.model,
          failureKind: groqRecognition.failureKind,
          httpStatus: groqRecognition.httpStatus || null
        });
        const recognition = groqRecognition.faq
          ? {
            ...deterministicRecognition,
            faq: groqRecognition.faq,
            intent: groqRecognition.faq.intent,
            classification: 'known_faq',
            confidence: groqRecognition.confidence,
            scoreMeaning: 'Groq-reported classification confidence; not a calibrated probability',
            strategy: 'groq_fallback',
            knowledgeId: groqRecognition.faq.id,
            reason: 'groq_fallback',
            fallbackReason: null
          }
          : deterministicRecognition;
        if (nlpEnabled || groqRecognition.attempted) {
          trace('relay_intent_recognized', intentDiagnostic(recognition));
        }
        const baseResult = processFaqPrompt(faqState, text, {
          transferAvailable,
          matcher: () => recognition.faq,
          classification: nlpEnabled ? recognition.classification : null,
          // Transfer consent remains deterministic in every classifier mode.
          strictConfirmation: true,
          // Turn context is local, call-scoped FAQ state and is safe to use
          // even when optional multilingual NLP classification is disabled.
          contextEnabled: true,
        });
        let selectedResult = baseResult;
        let responseSource = 'faq';
        let openAIStatus = null;
        const faqCannotAnswer = baseResult.faqId === 'unknown'
          || (baseResult.faqId === 'unclear'
            && /[?]|\b(?:what|how|why|when|where|which|who|price|pricing|cost|refund|exception|enna|epdi|evlo)\b/i.test(normalizedPrompt))
          || (baseResult.faqId === 'transfer_confirmation_unclear'
            && /[?]|\b(?:what|how|why|when|where|which|enna|epdi|evlo|benefit|cost|price|useful)\b/i.test(normalizedPrompt));
        const useOpenAI = baseResult.action === 'answer'
          && faqCannotAnswer
          && recognition.classification !== 'unrelated'
          && !isClearTransferConfirmation(text);

        // Explicit transfers and pending yes/no confirmations are already
        // resolved above by processFaqPrompt. OpenAI receives no control over
        // transfer decisions, call state, or handoff data.
        if (useOpenAI) {
          const generated = await conversationRelayOpenAI.generateConversationAnswer({
            transcript: text,
            history: conversationHistory,
            systemPrompt: data.systemPrompt,
            knowledgeBase: data.knowledgeBase,
            companyName: data.companyName,
            language: data.language
          });
          openAIStatus = {
            success: generated.success === true,
            reason: generated.reason || null,
            latencyMs: Number.isFinite(generated.latencyMs) ? Math.round(generated.latencyMs) : null,
            outputChars: Number.isFinite(generated.outputChars) ? generated.outputChars : null,
            httpStatus: generated.status || null,
            requestId: generated.requestId || null,
            historyMessages: conversationHistory.length
          };
          trace('relay_openai_answer', openAIStatus);
          faqState.awaitingHumanConfirmation = false;
          faqState.awaitingAutomationConfirmation = false;
          faqState.lastFaqId = null;
          faqState.lastFaqAt = null;
          responseSource = generated.success ? 'openai' : 'openai_fallback';
          selectedResult = {
            ...baseResult,
            faqId: generated.success ? 'openai_answer' : baseResult.faqId,
            answer: generated.success ? generated.answer : OPENAI_SPOKEN_FALLBACK,
            responseSource,
            contextResolution: baseResult.contextResolution || (baseResult.faqId === 'unknown'
              ? 'unmatched_question' : 'contextual_follow_up')
          };
          rememberTurn(text, selectedResult.answer);
        } else if (baseResult.action === 'answer') {
          rememberTurn(text, baseResult.answer);
        }

        const result = deliverConversationRelayFaqResult(selectedResult, {
          language: data.language || message.lang || 'en-IN',
          send: (payload) => sendFrame(payload, { frameSequence: sequence, turn: currentTurn,
            customerTurn: customerTurnNumber, responseSource })
        });
        trace('relay_faq_decision', {
          frameSequence: sequence, turn: currentTurn, customerTurn: customerTurnNumber,
          candidateFaqId: promptDiagnostic.candidateFaqId,
          selectedFaqId: result.faqId || null, action: result.action,
          classification: nlpEnabled ? recognition.classification : null,
          responseSource, openAIStatus: openAIStatus?.reason || (openAIStatus ? 'success' : null),
          responseStatus: result.responseStatus, contextResolution: result.contextResolution || null,
          stateBefore, stateAfter: snapshotFaqState(faqState),
          fallbackReason: responseSource === 'openai_fallback' ? openAIStatus?.reason
            : result.faqId === 'unknown' ? 'no_faq_intent_match'
            : result.faqId === 'transfer_confirmation_unclear' ? 'transfer_confirmation_unclear' : null
        });
        const matchedIntent = result.matchedIntent;
        logger.info('ConversationRelay FAQ match result', {
          event: 'faq_match_result', connectionId, correlationId, turn: currentTurn,
          customerTurn: customerTurnNumber, faqId: result.faqId || null,
          matchedIntent, action: result.action, stage: faqState.stage,
          contextResolution: result.contextResolution || null,
          awaitingHumanConfirmation: faqState.awaitingHumanConfirmation,
          awaitingAutomationConfirmation: faqState.awaitingAutomationConfirmation
        });
        logger.info('ConversationRelay FAQ prompt matched', {
          event: 'faq_matched', connectionId, correlationId, turn: currentTurn,
          faqId: result.faqId || null, matchedIntent, action: result.action,
          responseStatus: result.responseStatus,
          transferAvailable,
          transferDestinationReason: transferAvailable ? null : transferDestination.reason,
          chars: text.length,
          receivedTranscription: diagnosticText(text),
          normalizedTranscription: diagnosticText(normalizedPrompt)
        });
        logger.info('ConversationRelay FAQ response selected', {
          event: 'response_selected', connectionId, correlationId, turn: currentTurn,
          faqId: result.faqId || null, answerKey: result.faqId || 'unknown', matchedIntent,
          responseSource, responseChars: String(result.answer || '').length,
          ...(responseSource === 'openai' || responseSource === 'openai_fallback'
            ? {} : { selectedResponse: redactFaqDiagnosticText(result.answer || '') }),
          action: result.action
        });
        if (['unknown', 'transfer_confirmation_unclear'].includes(result.faqId)) {
          logger.warn('ConversationRelay fallback reason', {
            event: 'fallback_reason', connectionId, correlationId, turn: currentTurn,
            customerTurn: customerTurnNumber,
            reason: result.faqId === 'unknown' ? 'no_faq_intent_match' : 'transfer_confirmation_unclear'
          });
          logger.warn('ConversationRelay FAQ fallback selected', {
            event: 'faq_fallback_reason', connectionId, correlationId, turn: currentTurn,
            reason: result.faqId === 'unknown' ? (normalizedPrompt ? 'no_faq_intent_match' : 'empty_transcription')
              : 'transfer_confirmation_unclear'
          });
        }
        if (result.action === 'answer') {
          logger.info('ConversationRelay FAQ response sent', {
            event: 'response_sent', connectionId, correlationId, turn: currentTurn,
            faqId: result.faqId, matchedIntent, chars: result.answer.length,
            sent: result.responseStatus === 'spoken', responseStatus: result.responseStatus
          });
        } else if (result.action === 'transfer') {
          logger.info('ConversationRelay FAQ transfer requested', {
            event: 'transfer_requested', connectionId, correlationId,
            turn: currentTurn, faqId: result.faqId, matchedIntent,
            responseStatus: result.responseStatus,
            confirmationSent: result.faqId === 'ai_automation' ? result.confirmationSent : undefined,
            handoffSent: result.handoffSent
          });
          logger.info('ConversationRelay transfer confirmation response sent', {
            event: 'response_sent', connectionId, correlationId, turn: currentTurn,
            faqId: result.faqId, matchedIntent, sent: result.confirmationSent,
            responseStatus: result.confirmationSent ? 'spoken' : 'send_failed'
          });
          finished = true;
        } else if (result.action === 'end') {
          finished = true;
        }
      } catch (error) {
        logger.error('ConversationRelay message handler failed', {
          connectionId, correlationId, stage: 'message_handler', errorType: error?.name || 'Error'
        });
        if (getRelaySessionCallSid(relaySession) && !finished) {
          finished = true;
          sendFrame({ type: 'end', handoffData: JSON.stringify({ status: 'faq_goodbye' }) });
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
      const receivedAt = Date.now();
      const sequence = ++frameSequence;
      trace('relay_frame_received', {
        frameSequence: sequence, receivedAtUtc: new Date(receivedAt).toISOString(),
        bytes: Buffer.byteLength(raw), messageListenerCount: socket.listenerCount('message'),
        ...snapshotFaqState(faqState)
      });
      const result = frameQueue.enqueue({ raw, sequence, receivedAt });
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
      const commit = String(process.env.RENDER_GIT_COMMIT || '');
      trace('relay_runtime_identity', {
        handler: 'node_predefined_faq_v1', processId: process.pid, faqConfigurationHash,
        workingDirectory: process.cwd(), entryPoint: process.argv[1] || null,
        multilingualIntentEnabled: nlpEnabled,
        deployedCommit: /^[a-f0-9]{40}$/i.test(commit) ? commit : null,
        messageListenerCount: socket.listenerCount('message')
      });
      setupStage = 'tenant_authorization';
      workflowConfig = await Workflow.findOne({ _id: workflowId, createdBy: userId }).lean();
      const node = workflowConfig?.nodes?.find((entry) => entry.id === nodeId && entry.type === 'ai_voice_agent');
      if (!node) throw new Error('AI Voice Agent workflow node was not found for this tenant');
      data = node.data || {};
      setupStage = 'agent_configuration';
      const handoffDestination = resolveConnectedHandoffDestination(workflowConfig, nodeId);
      validateAgentConfig(data, handoffDestination.destination);
      relaySession = createRelaySessionContext({ userId, workflowId, nodeId });
      logger.info('ConversationRelay session initialized', {
        event: 'session_initialized', connectionId, correlationId, workflowId, nodeId,
        handler: 'node_predefined_faq_v1', stage: 'awaiting_setup'
      });
      logger.info('ConversationRelay tenant workflow authorized', {
        connectionId, correlationId, language: data.language, voice: data.voiceSelection
      });
    } catch (error) {
      logger.error('ConversationRelay setup failed', {
        connectionId, correlationId, stage: setupStage, errorType: error?.name || 'Error'
      });
      sendFrame({ type: 'end', handoffData: JSON.stringify({ status: 'error', reason: 'configuration' }) });
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
      sendFrame({ type: 'end', handoffData: JSON.stringify({ status: 'completed', reason: 'duration-limit' }) });
    }, Number(data.maxDuration || 300) * 1000);
    timer.unref?.();

    if (socket.readyState === WebSocket.OPEN) frameQueue.activate();
  }
}

export default new ConversationRelayService();
