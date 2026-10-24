export const RELAY_VOICES = Object.freeze({
  'mCQMfsqGDT6IDkEKR20a': 'en-IN',
  'UgBBYS2sOqTuMpoF3BR0': 'en-US',
  'Fahco4VZzobUeiPqni1S': 'en-GB',
  'ZhJ5LanYnCmLKQUXvsV7': 'ta-IN',
  'IvLWq57RKibBrqZGpQrC': 'hi-IN'
});

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
