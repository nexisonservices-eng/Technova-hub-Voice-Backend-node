# AI Voice Agent local setup

The AI Voice Agent workflow node uses Twilio ConversationRelay for streaming speech recognition and speech playback, this Node backend for the authenticated Relay WebSocket and workflow routing, and the existing Python AI service/Groq configuration for conversation turns. It does not create or store audio files: Relay synthesizes text responses directly during the live call.

## Prerequisites

- Install Node dependencies in `Technova-hub-Voice-Backend-node` and Python dependencies in `Technova-hub-Voice-Backend-python`.
- Configure the Python service with `GROQ_API_KEY`. It listens on port `4000` by default.
- Configure Node with its existing database/admin credential settings and `AI_SERVICE_HTTP=http://localhost:4000`. If Python `ENABLE_AUTH=true`, set the same `PYTHON_API_KEY` in both services.
- Configure `PUBLIC_WEBHOOK_BASE_URL` (recommended) or `BASE_URL` as the public HTTPS URL for the Node backend. The service uses it for both Twilio HTTP callbacks and the derived `wss://` Relay URL. A local-only `localhost` URL cannot be reached by Twilio.
- Configure the tenant's Twilio Account SID, Auth Token, and phone number through the existing Nexion credentials flow. The account must have ConversationRelay enabled and its AI/ML feature terms accepted in Twilio Console.
- For local calls, expose Node port `5000` through an HTTPS/WSS tunnel and set `PUBLIC_WEBHOOK_BASE_URL` to that tunnel URL. Keep Python private on localhost.

No new API secret is introduced. Do not put the Twilio Auth Token, Groq key, or Python API key in workflow node fields.

## Create and test a workflow

1. Start MongoDB, the Python service, and the Node backend. For example, run `python app.py` from the Python backend and `npm run dev` from the Node backend.
2. In Nexion, open Inbound IVR workflow builder and add **AI Voice Agent**. Configure the company name, welcome greeting, system instructions, approved business knowledge, discount question, language, and matching voice. Add a human destination if either transfer option is enabled.
3. Connect the node's `completed`, `transferred`, and `error` outputs to the appropriate existing workflow nodes. Save and activate the workflow using the existing workflow controls.
4. Place a test call through the existing Twilio call/workflow setup. Use an approved test destination. For a Tamil test, select `ta-IN` and `ZhJ5LanYnCmLKQUXvsV7`, then speak a Tamil question and confirm the caller receives a relevant Tamil reply. Try an explicit human request to test the transfer path.
5. Check Node logs for `Starting Twilio ConversationRelay`, the selected language/voice, signed WebSocket connection, turn generation, and callback/transfer result. Errors are logged without caller utterance text.

If the call does not connect, first verify the tunnel URL is identical to `PUBLIC_WEBHOOK_BASE_URL`, Twilio can reach port 5000 over HTTPS/WSS, the tenant credentials resolve, and ConversationRelay onboarding is complete. A successful code-level test does not substitute for a live Twilio account call.
