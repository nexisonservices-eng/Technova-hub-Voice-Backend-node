# Live FAQ investigation

The real WebSocket handler reproduces an unsolicited fallback when an empty final
prompt arrives before the first customer question. That frame previously entered
`processFaqPrompt`, selected `unknown`, and set `awaitingHumanConfirmation`.
The handler now ignores empty/noise-only final transcriptions without changing
FAQ state. The regression test fails before this guard and passes after it.

The reported first-question failure itself is still not reproduced: all seven
requested nonempty transcription variants already answer correctly on turn one,
including while workflow authorization and setup association are delayed. This
proves neither a production empty-frame cause nor the identity of the deployed
handler. Production logs are still required before claiming the live issue fixed.
Approved FAQ answers and all transfer behavior remain unchanged.

## Response path in this checkout

`npm start` runs `server.js`. The outbound workflow executes
`twilioIntegrationService.generateTwiML` → `ivrExecutionEngine.executeNode` →
`_handleAIVoiceAgent`, which generates ConversationRelay TwiML pointing at
`/ws/conversation-relay` and configures `FAQ_WELCOME`.

`server.js` verifies the WebSocket upgrade and invokes
`conversationRelayService.handleConnection`. Its ordered frame queue authenticates
the setup CallSid and creates one FAQ state for that connection. For a prompt it
extracts `message.voicePrompt`, logs normalization, ignores `last !== true`, then
calls `processLiveConversationRelayFaqTurn` → `processFaqPrompt` → `matchFaq` →
`normalizeFaqQuestion`. Approved FAQ entries select the Tamil answer, and `send`
uses `safeSend` to write `{type:'text', token:answer, lang:'ta-IN', last:true, ...}`.
This live handler does not call the LLM/Python `processRelayPrompt` path.

Services leaves the session listening. Automation sets the existing confirmation
flag. A final YES uses the existing Tamil confirmation and `faq_transfer` end
frame. `/webhook/twilio/ai-voice-agent/complete` handles that frame using the
existing Hand Off destination and dial logic. All transfer implementation,
callbacks, routing, destinations, voice, and Twilio configuration are untouched.

## Evidence needed from Render

For one already-observed failing call, provide:

- The Node service name, deployed commit SHA, repository/root directory, and
  build/start commands. Compare these to this checkout and `npm start`.
- Timestamp and timezone plus CallSid (no customer phone number).
- All log entries sharing that CallSid/correlationId and connectionId, starting
  with `relay_twiml_generated`, `upgrade_received`, signature validation,
  workflow authorization, setup authentication, and `faq_session_ready`.
- Each turn's `prompt_received` (including `last`, chars, language and redacted
  transcription), `normalized_prompt`, `faq_matched`, `response_selected`,
  `response_sent`, and `faq_fallback_reason`.
- New first-turn events: `session_initialized`, `faq_configuration_ready`,
  `first_turn_received`, `transcription_received`, `normalized_transcription`,
  `faq_match_result`, and `fallback_reason`. Initialization records include
  `handler: node_predefined_faq_v1`; first-turn records expose pending flags.
  Compare both occurrences' redacted transcription, normalization, FAQ result,
  and response. Check whether an empty final frame preceded the question.
- Any `prompt_partial`, `prompt_without_setup`, queue errors, handler errors,
  send failures, Twilio relay errors, or WebSocket close events for that session.

If these events are absent, first establish which deployed handler owns the call.
If the final transcription differs, use its redacted value to reproduce the
matcher failure. If a correct answer is selected but not heard, investigate the
send/relay error events instead of changing the matcher. `response_sent` reports
the local send attempt; it does not prove that the customer heard audio.
Do not share authorization headers, tokens, raw WebSocket URLs, or phone numbers.

## Local validation and deployment

The current focused run passed 31 tests, with zero failures and zero skips:

```sh
node --test --test-isolation=none test/conversationRelayFirstTurn.test.cjs test/conversationRelayFaq.test.cjs test/conversationRelaySession.test.cjs test/conversationRelayTransfer.test.cjs
```

`conversationRelayFirstTurn.test.cjs` uses Node 24 synchronous module hooks to
replace external SDKs, models, credential lookup and logging. It executes the
actual production WebSocket service, frame queue, session binding, FAQ state,
matcher and response frames. Workflow/setup lookups are deliberately held pending
while setup, partial and final frames arrive. It checks welcome TwiML, all seven
first-question variants, identical repeated questions, empty finals, NO/recovery,
YES gating, diagnostic ordering and pending flags. It does not exercise real
WebSocket networking, Twilio speech playback, or a production database.

The broader protocol run had 8 passes and 1 pre-existing failure:
`discount YES handoff is distinct from discount NO completion` reads
`sent[0].handoffData`, but `sent[0]` is the confirmation text frame. The existing
transfer code and that test were left unchanged.

The dependency-backed live integration test remains blocked by unavailable
Twilio/Express dependencies; installation was denied. It is not counted as passed.

The expanded integration test requires installed dependencies rather than
silently skipping. It simulates all requested language variants, partial and
final prompts, both exact answers in one session, partial/final YES, the actual
emitted handoff frame, and the existing callback/transfer completion function.
Models and sockets are local doubles; no calls are placed.

In the Node project, install dependencies with `npm ci --ignore-scripts`, then run:

```sh
node --test test/conversationRelayFaq.test.cjs test/conversationRelayLiveIntegration.test.cjs test/conversationRelayProtocol.test.cjs test/conversationRelaySession.test.cjs test/conversationRelayTransfer.test.cjs test/conversationRelay.test.cjs
```

After dependency-backed tests pass, review the empty-final guard, FAQ diagnostics
and tests, then manually deploy
the reviewed commit to the existing Node Render service using its existing build
and start commands. No environment, frontend, Python, workflow, voice, or transfer
configuration change is needed. The checked-in Render blueprint enables automatic
deployment, so account for the service's actual auto-deploy setting before pushing.
Use logs from a separately authorized call to validate production; this change
does not authorize a paid call. No deployment or call was performed here.
