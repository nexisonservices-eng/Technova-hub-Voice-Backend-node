export const RELAY_VOICES = Object.freeze({
  'mCQMfsqGDT6IDkEKR20a': 'en-IN',
  'UgBBYS2sOqTuMpoF3BR0': 'en-US',
  'Fahco4VZzobUeiPqni1S': 'en-GB',
  'ZhJ5LanYnCmLKQUXvsV7': 'ta-IN',
  'IvLWq57RKibBrqZGpQrC': 'hi-IN'
});

export const escapeXmlAttribute = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

export const resolveCallProvider = (call = {}) =>
  String(call.provider || call.providerData?.provider || '').trim().toLowerCase();

export const buildUnsupportedProviderTwiML = () =>
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say>The voice assistant is unavailable for this call provider. Please try again later.</Say><Hangup/></Response>';

export const buildConversationRelayTwiML = ({
  url, action, welcomeGreeting = '', welcomeGreetingInterruptible,
  language, voice,
  ttsProvider = 'ElevenLabs', transcriptionProvider = 'Google', transcriptionLanguage,
  reportInputDuringAgentSpeech = 'speech', speechTimeout = 2000
}) => {
  if (!/^wss:\/\//i.test(String(url || ''))) throw new Error('ConversationRelay requires a secure wss URL');
  if (!/^https:\/\//i.test(String(action || ''))) throw new Error('ConversationRelay requires a public HTTPS action URL');
  const attributes = {
    url, welcomeGreeting, welcomeGreetingInterruptible, language, voice, ttsProvider, transcriptionProvider,
    transcriptionLanguage,
    speechTimeout: String(speechTimeout), interruptible: 'any',
    reportInputDuringAgentSpeech
  };
  const relayAttributes = Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => `${key}="${escapeXmlAttribute(value)}"`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="${escapeXmlAttribute(action)}" method="POST"><ConversationRelay ${relayAttributes}/></Connect></Response>`;
};

export const validateAgentConfig = (data = {}) => {
  if (!RELAY_VOICES[data.voiceSelection] || RELAY_VOICES[data.voiceSelection] !== data.language) {
    throw new Error('AI Voice Agent voice does not match a supported ConversationRelay language');
  }
  const transferEnabled = data.transferOnCustomerRequest !== false || data.transferOnDiscountInterest !== false;
  if (transferEnabled && !/^\+[1-9]\d{7,14}$/.test(String(data.humanAgentPhoneNumber || '').trim())) {
    throw new Error('A valid human agent number is required when transfer is enabled');
  }
  return true;
};
