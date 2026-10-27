# Optional multilingual intent recognition

## Architecture and scope

`conversationRelayFaq.js` already owns approved Tamil answers, NFKC normalization,
Tamil mark preservation, Nexion aliases, a narrow Cyrillic STT repair, phrase
matching, edit distance and the confirmation state machine. Those remain the
source of truth. The new `conversationRelayIntent.js` reuses normalization,
edit distance and FAQ entries. It returns the existing FAQ object, intent,
rule confidence, language heuristic, reason and processing latency. It never
generates an answer. Existing intent names remain `COMPANY_SERVICES` and
`AI_AUTOMATION` for compatibility.

The WebSocket handler injects the selected FAQ into the existing state machine.
TwiML, approved answers, Tamil welcome, voice, transfer destination resolution,
tenant authentication, workflow execution and outgoing protocol are unchanged.
No dependencies, paid NLP API, Groq requests or remote calls were added. The
recognizer function boundary permits a future adapter after separate review;
such an adapter must return approved FAQ IDs, never arbitrary spoken answers.

## Activation and rollback

Default: disabled. Only `CONVERSATION_RELAY_MULTILINGUAL_NLP=true` enables it.
The setting is captured per connection. No environment file was changed.
Disable/unset the flag and restart workers for rollback; active connections
keep their original setting. Review and validate in staging before enabling.

Disabled mode uses the original matcher and confirmation behavior. Enabled mode
uses explicit Tamil/Tanglish aliases and complete configured phrases for the two
enhanced topics. Other topics use the existing FAQ matcher. Recognizer exceptions
fall back to that matcher with `recognizer_error` diagnostics. A deliberate
rejection of a services/automation phrase does not pass through the legacy fuzzy
matcher, since that would bypass the new confidence safeguards.

Similarity is limited to one edit in one non-topic Latin word of a phrase with
at least three tokens and equal token counts. Topic tokens must match explicit
aliases. No global fuzzy topic matching, embeddings or inferred translations.
Scores 0.99 (configured phrase), 0.9 (bounded similarity), and 0.8 (other legacy
FAQ) are deterministic rule scores, not calibrated probabilities.

Enabled transfer consent requires a complete short confirmation. Plain YES/NO,
Tamil confirmations and polite replies remain supported. Embedded affirmative
words in unknown longer questions cannot transfer. This intentionally rejects
some longer freeform confirmations that the original permissive matcher accepts.

## Frames and privacy

Only authenticated nonempty prompts with `last === true` route to the state
machine. Partial/invalid frames do not mutate state or produce output. Existing
ordered processing sends one response per accepted turn and ignores prompts
after transfer/end. Identical later questions receive answers: text/time-based
deduplication would swallow legitimate repetition or transfer consent. Twilio's
documented prompt frame has no unique turn ID, so a replayed identical final
cannot reliably be distinguished from an intentional repeated question.

`relay_intent_recognized` includes heuristic language, allowlisted canonical
normalized vocabulary (other tokens replaced by `[redacted]`), intent, confidence,
reason, fallback reason and local processing milliseconds. It excludes customer
prose and destinations. Enabled mode also suppresses transcript fields in the
older logs, since regex phone/email redaction alone cannot remove names or
addresses. Disabled mode retains existing logging. Existing keyed per-connection
fingerprints remain. Language detection distinguishes Tamil script, mixed Tamil
and Latin, likely Tanglish, and English-or-Latin; it is not an STT quality score.

## Speech configuration review (2026-10-27)

The live workflow in `ivrExecutionEngine.js` explicitly selects Deepgram STT,
`transcriptionLanguage="multi"`, ElevenLabs TTS, the configured language/voice,
the approved welcome, and bounded silence timeout. It does not explicitly select
a speech model. The generic TwiML builder's Google default is overridden there.

Twilio supports `multi` STT with Deepgram and automatic TTS with ElevenLabs:
https://www.twilio.com/docs/voice/twiml/connect/conversationrelay

Deepgram currently lists Tamil `ta` as a Nova-3 single-language option, but its
Nova-3 multilingual group lists ten languages and excludes Tamil. Thus the
current `multi` setting must not be assumed to recognize Tamil reliably:
https://developers.deepgram.com/docs/models-languages-overview/

For a separately approved staging trial, evaluate explicit Deepgram
`nova-3-general` with Tamil STT (`ta`, after confirming Twilio accepts the code),
and explicit English STT for English sessions. Twilio's nested Language elements
and switch-language messages support selecting per-language settings; defining
Language elements alone does not activate them. Verify the Twilio-supported
provider/model/language combination with the account before changing production.
Keep approved TTS and welcome. Test Tamil and English audio plus Tanglish
code-switching: a Tamil-specific model does not guarantee mixed-language quality.

## Validation and deployment risks

Added regression corpus: all requested examples; mixed scripts; bounded typo
repair; similar-word negatives; unknown questions; safe diagnostics; flag and
exception fallback; repeated questions; transfer consent. Added an actual
mocked WebSocket session case covering enabled first-turn Tamil, partial/final
handling, repetition and single handoff. Existing ConversationRelay suites
exercise TwiML, session association, queueing and connected Hand Off destinations.

Syntax checks for all five changed/new JavaScript/test files and `git diff
--check` passed. Runtime test attempt `node --test test/conversationRelay*.test.cjs`
was blocked by sandbox `spawn EPERM`. The escalation request was rejected, so
runtime pass counts and accuracy/latency benchmarks are unavailable. These tests
must pass before rollout. The package's `npm test` uses Jest, whereas these
existing `.cjs` tests use Node's built-in test runner; use the Node command above.

No production traffic/audio was used. Local intent latency is measured per call
to the recognizer, excluding STT, WebSocket queueing, TTS and network time. No
production latency or speech accuracy claim can be made from this corpus.

Conservative full-phrase rules can reject unfamiliar paraphrases, dialects,
transpositions and severe STT errors. Other legacy intents retain their existing
substring-matching limitations. New intents/aliases need reviewed examples and
negative cases. Confidence is not a guarantee of intent correctness. The NLP
layer cannot recover words absent from an incorrect transcript. Approved
automation answers still offer transfer, even for definition questions; that
business content is intentionally unchanged. Run staged audio trials and review
fallback rates before enabling the flag. Nothing has been deployed or pushed.
