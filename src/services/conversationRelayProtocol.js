export const buildTextTokenMessage = (token) => ({
  type: 'text', token: String(token || ''), last: true, interruptible: true
});

export const buildAiFailureMessage = () => buildTextTokenMessage(
  "I'm sorry, I'm having trouble right now. Please try asking again."
);

export const createOrderedRelayFrameQueue = (handler, maxBufferedFrames = 32, onError = () => {}) => {
  let active = false;
  const buffered = [];
  let chain = Promise.resolve();
  const enqueue = (frame) => {
    if (!active) {
      if (buffered.length >= maxBufferedFrames) return { accepted: false, overflow: true, buffered: buffered.length };
      buffered.push(frame);
      return { accepted: true, buffered: buffered.length };
    }
    chain = chain.then(() => handler(frame)).catch((error) => onError(error));
    return { accepted: true, buffered: 0 };
  };
  const activate = () => {
    active = true;
    const earlyFrames = buffered.splice(0);
    for (const frame of earlyFrames) enqueue(frame);
    return chain;
  };
  return { enqueue, activate, get bufferedCount() { return buffered.length; } };
};

export const processRelayPrompt = async ({
  message, callSid, isCurrent = () => true, requestAI, send,
  shouldTransfer = () => false, onAIResult = () => {}, onStage = () => {}
}) => {
  if (message?.type !== 'prompt') return { status: 'ignored', reason: 'event-type' };
  if (typeof message.last !== 'boolean') {
    onStage('prompt_invalid', { reason: 'missing_last_flag' });
    return { status: 'invalid', reason: 'missing_last_flag' };
  }
  if (message.last === false) {
    onStage('prompt_partial', { language: message.lang || null });
    return { status: 'partial' };
  }

  const text = typeof message.voicePrompt === 'string' ? message.voicePrompt.trim() : '';
  if (!text || text.length > 3000 || !callSid) {
    onStage('prompt_invalid', {
      reason: !callSid ? 'missing_setup' : (!text ? 'missing_text' : 'text_too_long'),
      hasText: Boolean(text), hasCallSid: Boolean(callSid), chars: text.length
    });
    return { status: 'invalid' };
  }

  onStage('speech_received', { language: message.lang || null, chars: text.length });
  try {
    const result = await requestAI(text, message);
    if (!isCurrent()) return { status: 'stale' };
    const answer = String(result?.response || '').trim();
    if (!answer) throw new Error('AI service returned an empty response');
    onAIResult(result);

    if (shouldTransfer(result)) {
      if (String(result.intent || '').toLowerCase() === 'discount_yes') {
        send(buildTextTokenMessage(answer));
      }
      send({ type: 'end', handoffData: JSON.stringify({ status: 'transfer', intent: result.intent }) });
      onStage('transfer_requested', { intent: result.intent });
      return { status: 'transfer', result };
    }
    if (String(result.intent || '').toLowerCase() === 'discount_no') {
      send({ type: 'end', handoffData: JSON.stringify({ status: 'completed', reason: 'discount-declined' }) });
      onStage('session_end_requested', { reason: 'discount-declined' });
      return { status: 'end', result };
    }
    if (String(result.intent || '').toLowerCase() === 'end_call') {
      send({ type: 'end', handoffData: JSON.stringify({ status: 'completed', reason: 'customer-ended' }) });
      onStage('session_end_requested', { reason: 'customer-ended' });
      return { status: 'end', result };
    }

    const sent = send(buildTextTokenMessage(answer));
    onStage(sent ? 'response_sent' : 'response_send_failed', {
      intent: String(result.intent || 'continue').toLowerCase(), chars: answer.length
    });
    return { status: sent ? 'spoken' : 'send-failed', result };
  } catch (error) {
    if (!isCurrent()) return { status: 'stale' };
    const sent = send(buildAiFailureMessage());
    onStage('ai_turn_failed', {
      errorType: error?.name || 'Error', status: error?.response?.status || null,
      errorCode: error?.code || null, fallbackSent: sent
    });
    return { status: 'failed', error };
  }
};
