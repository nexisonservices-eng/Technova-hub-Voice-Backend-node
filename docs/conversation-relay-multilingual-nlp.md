# ConversationRelay multilingual NLP

## What the pipeline does

`conversationRelayIntent.js` validates the transcript type and size, applies NFKC
normalization and the existing conservative Tamil/Tanglish aliases, detects
script hints, checks explicit workflow rules, reuses configured FAQ matching,
and then scores the remaining FAQ patterns with a symmetric token Dice score.
That score is a retrieval signal, not a probability. Semantic retrieval uses no
network calls, embeddings, paid service, or new runtime dependency. Close or weak
matches are rejected. The returned FAQ object is always the approved source for
the spoken answer; the recognizer does not generate facts.

The enabled registry covers greetings, services/company information, AI
automation, Nexion, Nexion benefits, repetitive tasks, supported businesses,
offers, contact details, thanks, direct human requests, and goodbye. Pricing is
not in the approved knowledge base and is deliberately rejected. Current answer
content is Tamil; language detection of caller input does not translate or
rewrite answers. The context helper stores only the last FAQ ID and its timestamp
for five minutes. A recognized reference can repeat that approved answer; the
system does not invent a deeper explanation or an example absent from the FAQ.

High-impact handoff and goodbye decisions use bounded rules. A human mention
alone, a negated request, or a plain acknowledgement without a pending explicit
confirmation does not cause transfer. Transfer destination resolution, pending
confirmation state, workflow execution, and handoff actions remain in the
existing ConversationRelay / FAQ state machine. Partial frames are ignored,
ordered queue handling processes each received frame once, and completed calls
ignore later prompts. Twilio prompt frames do not expose a stable utterance ID
in this integration, so identical consecutive final transcripts cannot be
reliably distinguished from an intentional repeated question. The handler does
not suppress them based only on matching text; this preserves legitimate
repeated questions and avoids dropping a real transfer confirmation.

## Flag and thresholds

`CONVERSATION_RELAY_MULTILINGUAL_NLP` remains opt-in and is snapshotted for each
connection. No production environment file was changed. When disabled, the
original FAQ matcher remains the selection path for compatibility. When enabled,
explicit transfer and goodbye boundaries are stricter. A recognizer exception
falls back to the legacy matcher.

Optional score thresholds are process environment settings:

- `CONVERSATION_RELAY_NLP_DIRECT_THRESHOLD`: direct rule threshold, default
  `0.9`, accepted range `0.5` to `1.0`.
- `CONVERSATION_RELAY_NLP_SEMANTIC_THRESHOLD`: token retrieval threshold,
  default `0.72`, accepted range `0.5` to `1.0`.
- `CONVERSATION_RELAY_NLP_HANDOFF_THRESHOLD`: explicit handoff rule threshold,
  default `0.98`, accepted range `0.9` to `1.0`.

These are heuristic thresholds, not statistically calibrated probabilities.
The included labelled corpus is regression coverage, not a representative call
dataset. Calibrate with reviewed, consented staging utterances before rollout.

## Speech recognition and speech output

The live IVR path configures Twilio ConversationRelay with Deepgram as the
transcription provider, `transcriptionLanguage="multi"`, ElevenLabs TTS, and
the existing configured voice. Twilio documents that `multi` requires Deepgram
for STT and ElevenLabs for TTS. Deepgram's current Nova-3 multilingual
documentation lists Tamil, English, and mid-sentence code-switching. The code
does not select a Deepgram speech model explicitly, so the exact account-side
model, availability, and audio accuracy have not been verified in a live call.
Provider support does not guarantee recognition accuracy for this call path.

The separate Python audio transcription service uses Groq with the configured
`distil-whisper-large-v3-en` model and defaults its request language to English.
It is not the STT path used by the Twilio ConversationRelay FAQ handler.

## Optional Node-side Groq intent fallback

The authenticated Node ConversationRelay handler can optionally make a
classification-only Groq chat-completions request after its deterministic FAQ
resolver returns no FAQ. It skips known FAQ matches, standalone confirmations,
recognized unrelated topics, and unsupported pricing/policy questions. It sends
only the current sanitized utterance; it does not send call identifiers,
conversation history, or phone numbers. Groq can return only `services`,
`ai_automation`, or `unknown`. A recognized intent selects the existing matching
FAQ entry and answer; an unknown result or any API/JSON/validation failure keeps
the existing fallback.

This Node fallback is off unless `GROQ_NLP_ENABLED=true`. If enabled, configure
`GROQ_API_KEY` in the Node service environment. Optional settings are
`GROQ_NLP_MODEL` (defaults to `openai/gpt-oss-20b`),
`GROQ_NLP_TIMEOUT_MS` (defaults to 1500; accepted range 250–10000), and
`GROQ_NLP_CONFIDENCE_THRESHOLD` (defaults to 0.8; accepted range 0.5–1.0).
Model availability and JSON-mode support can change; choose an active model that
supports JSON Object Mode. Groq documents the chat-completions endpoint and
`response_format: { type: "json_object" }` in its [API reference](https://console.groq.com/docs/api-reference),
and currently lists JSON Object Mode for [OpenAI GPT-OSS 20B](https://console.groq.com/docs/model/openai/gpt-oss-20b).
API usage, billing, and rate limits depend on the Groq account and selected
model; no free-usage assumption is made. No API call is made in tests.

Sources: [Twilio ConversationRelay language settings](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay),
[Deepgram Nova-3 language prompting and code-switching](https://developers.deepgram.com/docs/nova-3-language-prompting),
[Deepgram model and language overview](https://developers.deepgram.com/docs/models-languages-overview/).

Speech recognition produces the transcript; this NLP module only interprets
that text. It cannot restore words missing from a poor transcript. TTS output
does not establish STT accuracy. The separate Python TTS integration was not
changed; its HTTP failures are not NLP failures.

## Diagnostics and privacy

Intent diagnostics include stage, selected strategy, text-derived language hint,
the validated language hint reported by the STT provider, deterministic and
Groq intent outcomes, confidence, selected answer key, Groq attempt status,
fallback reason, and local processing latency. Prompt diagnostics preserve only
allowlisted FAQ vocabulary; other words are replaced with `[redacted]`. Outgoing
text diagnostics contain only the configured response after content redaction.
Matching fingerprints use a random per-connection HMAC key and are not reusable
across calls. No API keys, auth tokens, phone numbers, or caller names are added
to diagnostics.

## Test and local staging procedure

The repository tests use Node's built-in `node:test` API. `npm test` now invokes
`node --test`; Node 18 or later is required by the test harness. Run focused NLP
coverage with:

```powershell
node --test test/conversationRelayIntent.test.cjs test/conversationRelayFaq.test.cjs test/conversationRelayNlpPipeline.test.cjs test/conversationRelayProtocol.test.cjs
```

The `conversationRelay.test.cjs` module imports the TTS client and needs a
well-formed `PYTHON_TTS_BASE_URL`, but does not call the service. For a local
suite run, set a test-only value in the shell (for example,
`http://127.0.0.1:4000`), run `npm test`, then remove the shell variable:

```powershell
$env:PYTHON_TTS_BASE_URL = 'http://127.0.0.1:4000'
npm test
Remove-Item Env:PYTHON_TTS_BASE_URL
```

Do not write this test value to production configuration. Run `node --check` on changed
JavaScript files and `git diff --check` before review. The labelled corpus reports
recognition accuracy and observed local matcher latency when it runs. These
measure text matching only and exclude STT, TTS, WebSocket queueing, and network
time.

For an isolated staging process, set the flag in that process environment only,
for example `$env:CONVERSATION_RELAY_MULTILINGUAL_NLP = 'true'`, and clear it
after the process exits. Confirm the effective Twilio STT/TTS configuration and transfer destination,
and exercise reviewed English, Tamil-script, Tanglish, code-switched, unknown,
negated-transfer, and confirmation cases. Compare transcripts and outcomes with
the expected labels; review fallback and false-transfer counts before any
rollout. Unset the flag and restart the staging worker to return to legacy
matching. Do not copy the flag into production configuration as part of this
change.

## Limits and rollout checklist

- FAQ coverage is limited to the existing approved facts. Pricing and
  unsupported service claims fall back instead of being generated.
- With the flag disabled, the original legacy FAQ matcher is retained for
  compatibility, including its broader substring handling. The stricter
  transfer and goodbye guards apply in the opt-in NLP path.
- Token similarity is explainable and fast but is not a full semantic model.
  Unseen paraphrases, dialects, speech-recognition errors, and ambiguous
  questions may fall back or request the existing clarification.
- Follow-ups repeat the last approved answer where possible. Itemized service
  details and custom examples are not available in the current knowledge base.
- The labelled fixtures are authored regression examples. They do not establish
  production precision, recall, false-transfer rate, or speech accuracy.
- No new recurring cost or model API is introduced. Local matcher latency is
  reported by tests; live end-to-end latency remains unmeasured.

Before any separate rollout decision, verify the installed Twilio account's
provider/model support, run the complete suite and syntax checks, evaluate
consented staging audio, review false handoffs and fallbacks, confirm the
connected Hand Off destination, and review `CONVERSATION_RELAY_NLP_*` thresholds.
This code change does not enable the feature in production and has not been
deployed or pushed.
