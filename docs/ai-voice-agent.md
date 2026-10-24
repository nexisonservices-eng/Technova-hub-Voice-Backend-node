# AI Voice Agent local setup

The AI Voice Agent workflow node uses Twilio ConversationRelay for streaming speech recognition and speech playback, this Node backend for the authenticated Relay WebSocket and workflow routing, and the existing Python AI service/Groq configuration for conversation turns. It does not create or store audio files: Relay synthesizes text responses directly during the live call.

The outbound flow can play its configured script/audio intro using TwiML `Say` or `Play` before redirecting into the workflow. The AI Voice Agent's separate welcome is the `welcomeGreeting` attribute on `<ConversationRelay>`; hearing the initial intro alone does not prove the Relay WebSocket or speech-to-AI path is active.

## Prerequisites

- Install Node dependencies in `Technova-hub-Voice-Backend-node` and Python dependencies in `Technova-hub-Voice-Backend-python`.
- Configure the Python service with `GROQ_API_KEY`. It listens on port `4000` by default.
- Configure Node with its existing database/admin credential settings and `AI_SERVICE_HTTP` pointing at the Python service root. The Node service also accepts its existing `PYTHON_TTS_BASE_URL` as a fallback AI-service URL (local development defaults to `http://localhost:4000`). If Python `ENABLE_AUTH=true`, set the same `PYTHON_API_KEY` in both services; Node sends it as `X-API-Key` and Python rejects mismatches with HTTP 401.
- Keep the Python service's `GROQ_API_KEY` configured. The default model is `openai/gpt-oss-20b`, which supports Groq JSON Object Mode; if `AI_MODEL` is set explicitly in Render, make sure that model is currently active and supports `response_format={"type":"json_object"}`. The old default `llama-3.1-8b-instant` was decommissioned by Groq in August 2026.
- Configure `PUBLIC_WEBHOOK_BASE_URL` (recommended) or `BASE_URL` as the public HTTPS URL for the Node backend. The service uses it for both Twilio HTTP callbacks and the derived `wss://` Relay URL. A local-only `localhost` URL cannot be reached by Twilio.
- Configure the tenant's Twilio Account SID, Auth Token, and phone number through the existing Nexion credentials flow. The account must have ConversationRelay enabled and its AI/ML feature terms accepted in Twilio Console.
- For local calls, expose Node port `5000` through an HTTPS/WSS tunnel and set `PUBLIC_WEBHOOK_BASE_URL` to that tunnel URL. Keep Python private on localhost.

No new API secret is introduced. Do not put the Twilio Auth Token, Groq key, or Python API key in workflow node fields.

## Create and test a workflow

1. Start MongoDB, the Python service, and the Node backend. For example, run `python app.py` from the Python backend and `npm run dev` from the Node backend.
2. In Nexion, open Inbound IVR workflow builder and add **AI Voice Agent**. Configure the company name, welcome greeting, system instructions, approved business knowledge, discount question, language, and matching voice. Add a human destination if either transfer option is enabled.
3. Connect the node's `completed`, `transferred`, and `error` outputs to the appropriate existing workflow nodes. Save and activate the workflow using the existing workflow controls.
4. Place a test call through the existing Twilio call/workflow setup. Use an approved test destination. For a Tamil test, select `ta-IN` and `ZhJ5LanYnCmLKQUXvsV7`, then speak a Tamil question and confirm the caller receives a relevant Tamil reply. Try an explicit human request to test the transfer path.
5. Check Node and Python logs using the Twilio CallSid correlation ID. Node records signature validation, tenant workflow authorization, WebSocket setup/close, received message types, transcription character count, Python request status/duration, and outgoing text-token status. Python logs model/auth configuration, input/output character counts, and provider error type without caller utterance text or API keys.

If the call does not connect, first verify the tunnel URL is identical to `PUBLIC_WEBHOOK_BASE_URL`, Twilio can reach port 5000 over HTTPS/WSS, the tenant credentials resolve, and ConversationRelay onboarding is complete. A successful code-level test does not substitute for a live Twilio account call.
