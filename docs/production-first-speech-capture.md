# Production first-question investigation and capture procedure

Status: **unresolved; not reported fixed**. No deployment or call was performed.
The authorized fallback action is implemented: diagnostics in the runtime handler,
not an unproven change to FAQ routing or speech settings.

## Evidence and revision

Reported call: `CA3a393a788a9efea092e6469187766089`, 2026-10-26 UTC.
09:34:38: `declined_transfer`; 09:34:50: `services` response sent;
09:35:06: `unknown` / `no_faq_intent_match`.

The events before 09:34:38 have not been retrieved. The first transcript, its
final flag, normalization, first response and first fallback reason remain
unknown. In this code, a decline requires a prior human-confirmation flag and
a negative reply; it does not prove which utterance set that flag. Unknown
questions and the offers FAQ can both set it.

Local base commit: `2ec2968ec19947441e35d3f03749486ca468cd41`.
This report and the runtime diagnostics are uncommitted working-tree changes,
not part of that commit. No new commit hash or deployed revision is claimed.
The read-only GitHub lookup failed inside the sandbox and the escalation was
declined. A Render integration was discovered but is not connected. The local
revision cannot be equated with GitHub HEAD or the deployed service.

## Actual outbound path in this repository

1. `src/services/twilioIntegrationService.js: generateTwiML` dispatches to
   `src/services/ivrExecutionEngine.js: executeNode / _handleAIVoiceAgent`.
2. `_handleAIVoiceAgent` generates ConversationRelay TwiML, using the existing
   approved greeting, voice and completion URL.
3. `server.js` has one ConversationRelay upgrade path and one connection listener.
   It authenticates the Twilio signature and invokes
   `src/services/conversationRelayService.js: handleConnection`.
4. Its message listener is attached before asynchronous workflow authorization.
   An ordered queue holds frames during authorization and serializes setup lookup
   with later speech. Authenticated `setup` creates FAQ state before subsequent
   queued prompts run.
5. A `prompt` uses `voicePrompt`, normalizes via `normalizeFaqQuestion`, and only
   routes a nonempty `last === true` prompt. Partial prompts do not mutate state.
   `interrupt` logs and returns. Other event types do not enter FAQ routing.
6. `processLiveConversationRelayFaqTurn` calls `processFaqPrompt` / `matchFaq`
   synchronously and sends the approved response. No asynchronous LLM fallback
   competes with this path. No second FAQ response handler was found locally.
7. Outgoing `end` frames carry the existing handoff payload. The completion route
   in `src/routes/twilioWebhookRoutes.js` preserves the connected Hand Off flow.

ConversationRelay begins with `setup`, rather than a Media Streams `start` event.
The documented inbound protocol has `prompt`, `interrupt`, DTMF and error messages;
`end` is an application-to-Twilio message. See [Twilio's WebSocket protocol](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages).

Local TwiML requests Deepgram / `multi`, ElevenLabs and the configured Tamil
voice, `welcomeGreetingInterruptible='none'` and
`reportInputDuringAgentSpeech='none'`. Twilio documents that the latter controls
whether speech is reported during playback. This makes welcome timing relevant
if speech is missing; it is **not a confirmed explanation for this call**.
See [Twilio's interaction settings](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay#interaction-between-interruptible-and-reportinputduringagentspeech).

## Runtime changes

`conversationRelayService.js` adds `relay_first_speech_v2` structured events:

| Event | Evidence captured |
| --- | --- |
| `relay_runtime_identity` | Validated `RENDER_GIT_COMMIT` or null, process and handler instance IDs, FAQ configuration hash, message listener count |
| `relay_frame_received` | Per-connection arrival sequence, UTC arrival timestamp, readiness before queuing, listener count, frame byte count |
| `relay_frame_processing` | Same sequence after queue wait, event type, processing readiness and state |
| `relay_prompt_disposition` | Exact boolean/type of `last`, prompt field type and lengths, matcher candidate, routing or rejection reason |
| `relay_faq_input` | Pre-routing state, confirmation classification, candidate match and comparison with previous final |
| `relay_faq_decision` | Candidate versus state-machine selection, fallback reason, response status and before/after pending flags |
| `relay_output_attempt/enqueued/write` | Per-connection outbound sequence, originating input sequence/turn, frame type, acceptance and asynchronous local write outcome |
| `relay_interruption` | Input sequence, playback duration from Twilio, interrupted text length and current state |
| `relay_session_summary` | Arrival/prompt/customer/output counts and ending state |

The queue carries the arrival metadata with the original frame. Existing routing
and output bytes are preserved. All handler output paths, including errors and
duration timeout, use the traced sender. `_handleAIVoiceAgent` additionally logs
the speech settings actually used when generating TwiML, without logging URLs or
credentials. Existing redacted transcript and selected-response events remain.
New diagnostic events add no transcript, phone number, URL, or credential content.
Transcript comparison uses a per-connection secret HMAC key that is never logged;
its fingerprints cannot compare speech across calls.

Repeated finals are identified diagnostically, not suppressed by a text/time
heuristic: identical questions can be intentional, as in the reported call.
No protocol utterance ID or actual duplicate sequence was supplied. There is no
new claim that duplicate finals or a second deployed handler are prevented.
Likewise, diagnostic write completion proves no audible TTS playback.

## Verification

44 tests pass, zero fail or skip:

```sh
node --test --test-isolation=none test/conversationRelayFirstTurn.test.cjs test/conversationRelayFaq.test.cjs test/conversationRelaySession.test.cjs test/conversationRelayTransfer.test.cjs
```

These execute the actual message handler, queue, binding, normalization, FAQ
state machine and output sender. External models, SDKs and sockets are doubles.
The tests cover first services/automation answers, Tamil/Tanglish/English variants,
early queued speech, speech after setup, partial then final, interruption,
one output per ordinary completed question, intentional repetition, NO recovery,
pending YES handoff frames, input/output correlation, asynchronous write errors,
deployment identity and absence of transcript text in the new diagnostics.

Syntax checks for both changed runtime files and `git diff --check` pass.
The expanded run additionally had 6 passing configuration tests, 3 skipped
SDK-dependent tests, and 1 integration failure because `twilio` is not installed.
Dependency installation was previously declined; none was attempted here.
The real completion-callback integration is not counted as passing.

Readiness timing in a mock socket cannot prove actual welcome playback timing,
STT quality, TTS delivery or a successful live Hand Off. Scenarios C/D require
actual calls. Separate fresh calls are needed to prove both services and automation
as the first question, and both welcome timing cases; one call cannot prove all.

## Required Render steps (manual; do not deploy automatically)

1. Connect Render access or inspect its dashboard. Verify the existing outbound
   Node service's repository, branch, root directory, build/start commands and
   deployed commit. Retrieve the historical call logs first if retained. Search
   the callSid, then include its connectionId to recover pre-setup events.
2. Review this diff and run the dependency-backed suite in an environment with
   project dependencies installed (`npm ci --ignore-scripts` there). Resolve
   missing dependencies before relying on the completion-callback integration.
3. Commit only the reviewed changes and record the resulting full SHA. Do not
   mistake the base SHA above for the diagnostic revision. Check the service's
   auto-deploy setting before any push; the local blueprint says `autoDeploy: true`.
4. After deployment authorization, manually deploy that exact reviewed commit
   to the existing Node service. Preserve its current environment and configuration.
   The checked-in blueprint uses `npm install` and `npm start`; verify the actual
   service uses the intended repository/root and `server.js` entry point.
5. During the controlled call, verify `relay_runtime_identity.deployedCommit`
   equals that SHA and `diagnosticVersion` is `relay_first_speech_v2`. Null or
   different revision means deployed identity has not been established.

## Single controlled call needed to capture the failure

An authorized operator makes **one fresh outbound call** on the existing saved
workflow. Record the new callSid and UTC time. As the welcome finishes, ask exactly
`Enna services pandringa?` once, at the same timing used in failing calls. Note
whether speech overlapped the greeting. Wait for the complete first answer.
If fallback occurs, say `No`, wait, then repeat the exact question once. If it
answers correctly immediately, end the call; that run did not reproduce failure.
No paid call is authorized or initiated by this report.

Export logs from TwiML generation through connection close for the new callSid
and every associated connectionId. Include ALL frames before the first fallback,
not only the three later FAQ results. Do not include raw authenticated WebSocket
URLs, headers, credentials or caller numbers.

Interpret the trace before choosing a fix:

- Missing first prompt: compare the operator's overlap note, generated TwiML
  settings, raw frame arrivals, interrupt and close/error events. The handler
  cannot recover speech Twilio never sends. Do not change matcher aliases.
- First prompt partial-only or invalid flag: inspect exact flag type, whether a
  final follows, queue wait and session lifetime. Do not process partials blindly.
- Incorrect first final text: compare existing redacted raw/normalized transcript
  events with the repeat and actual STT configuration. Add the actual frames to
  the real-handler regression before changing normalization or recognition.
- Correct final text: compare `candidateFaqId`, selected FAQ, pre/post pending
  flags, readiness and output frames. Candidate/selection divergence identifies
  state precedence; several outputs or connections identify competing processing.
- Correct answer selected and written: inspect Twilio errors and audio delivery;
  a successful local send alone does not establish what the customer heard.

Only after the evidence-backed runtime correction is reviewed and deployed, repeat
the fresh-call check and complete A-H live verification, including the existing
pending transfer YES/NO flow. Do not mark the issue fixed until the first services
answer is verified audibly on a real fresh call.
