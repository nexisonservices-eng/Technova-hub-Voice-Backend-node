export const buildTextTokenMessage = (token) => ({
  type: 'text', token: String(token || ''), last: true, interruptible: true
});

export const buildAiFailureMessage = () => buildTextTokenMessage(
  "I'm sorry, I'm having trouble right now. Please try asking again."
);

export const processRelayPrompt = async ({
  message, callSid, isCurrent = () => true, requestAI, send,
  shouldTransfer = () => false, onAIResult = () => {}, onStage = () => {}
}) => {
  if (message?.type !== 'prompt') return { status: 'ignored', reason: 'event-type' };
  if (message.last === false) {
    onStage('prompt_partial', { language: message.lang || null });
    return { status: 'partial' };
  }

  const text = String(message.voicePrompt || '').trim();
  if (!text || !callSid) {
    onStage('prompt_invalid', { hasText: Boolean(text), hasCallSid: Boolean(callSid) });
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
      send({ type: 'end', handoffData: JSON.stringify({ status: 'transfer', intent: result.intent }) });
      onStage('transfer_requested', { intent: result.intent });
      return { status: 'transfer', result };
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
