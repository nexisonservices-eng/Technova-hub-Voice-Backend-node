const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.PYTHON_TTS_BASE_URL = 'https://python-tts.example';

const loadService = async () => {
  const [{ default: service }, { default: axios }] = await Promise.all([
    import('../src/services/pythonTTSService.js'),
    import('axios')
  ]);
  return { service, axios };
};

test('TTS generation calls broadcast directly and canonicalizes the en-US alias', async () => {
  const { service, axios } = await loadService();
  const originalGet = axios.get;
  const originalPost = axios.post;
  const getUrls = [];
  let postArgs;
  axios.get = async (url) => {
    getUrls.push(url);
    return { data: { voices: [] } };
  };
  axios.post = async (...args) => {
    postArgs = args;
    return { data: Buffer.from('mp3-bytes') };
  };

  try {
    const result = await service.generateSpeech('Test announcement', 'en-US');
    assert.equal(result.toString(), 'mp3-bytes');
    assert.equal(getUrls.some((url) => url.endsWith('/health')), false);
    assert.equal(postArgs[0], 'https://python-tts.example/tts/broadcast');
    assert.equal(postArgs[1].language, 'en-GB');
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }
});

test('TTS provider failure is propagated with its HTTP status', async () => {
  const { service, axios } = await loadService();
  const originalGet = axios.get;
  const originalPost = axios.post;
  axios.get = async () => ({ data: { voices: [] } });
  const providerError = new Error('Request failed with status code 502');
  providerError.response = { status: 502, data: Buffer.from('{"detail":"TTS provider failed"}') };
  axios.post = async () => { throw providerError; };

  try {
    await assert.rejects(service.generateSpeech('Test announcement', 'en-GB'), (error) => {
      assert.equal(error.response.status, 502);
      return true;
    });
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }
});

test('Tamil voice and Unicode text reach the Python provider unchanged', async () => {
  const { service, axios } = await loadService();
  const originalGet = axios.get;
  const originalPost = axios.post;
  let payload;
  axios.get = async () => ({ data: { voices: [] } });
  axios.post = async (_url, body) => {
    payload = body;
    return { data: Buffer.from('ID3mock-mp3') };
  };
  const tamil = 'வணக்கம்! உங்கள் அழைப்புக்கு நன்றி.';
  try {
    const audio = await service.generateSpeech(tamil, 'ta-IN', 'ta-IN-PallaviNeural');
    assert.equal(audio.toString(), 'ID3mock-mp3');
    assert.equal(payload.text, tamil);
    assert.equal(payload.voice, 'ta-IN-PallaviNeural');
    assert.equal(payload.language, 'ta-IN');
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }
});

test('outbound campaign Twilio playback uses Play for generated MP3 URLs', async () => {
  const { default: campaigns } = await import('../src/services/outboundCampaignService.js');
  const { default: outbound } = await import('../src/controllers/OutboundController.js');
  const twiml = campaigns.buildTwilioCampaignTwiML({ audioUrl: 'https://res.cloudinary.com/demo/video/upload/calls/tamil.mp3' });
  assert.match(twiml, /<Play>https:\/\/res\.cloudinary\.com\/demo\/video\/upload\/calls\/tamil\.mp3<\/Play>/);
  assert.doesNotMatch(twiml, /<Say/);
  const quickCallTwiml = outbound.buildTwilioTwiML({ audioUrl: 'https://res.cloudinary.com/demo/video/upload/calls/tamil.mp3' });
  assert.match(quickCallTwiml, /<Play>https:\/\/res\.cloudinary\.com\/demo\/video\/upload\/calls\/tamil\.mp3<\/Play>/);
  assert.doesNotMatch(quickCallTwiml, /<Say/);
});

test('Tamil outbound campaign audio failure is returned instead of falling back to English Say', async () => {
  const { default: campaigns } = await import('../src/services/outboundCampaignService.js');
  const { default: tts } = await import('../src/services/pythonTTSService.js');
  const original = tts.getAudioForPrompt;
  tts.getAudioForPrompt = async () => { throw new Error('Edge TTS unavailable'); };
  try {
    await assert.rejects(
      campaigns.resolveScriptAudioAsset({ script: 'தமிழ் உரை', voiceId: 'ta-IN-PallaviNeural', language: 'ta-IN', userId: 'tenant-test' }),
      /Tamil audio generation failed/
    );
  } finally {
    tts.getAudioForPrompt = original;
  }
});
