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
