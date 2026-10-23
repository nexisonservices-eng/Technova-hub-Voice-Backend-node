const { test } = require('node:test');
const assert = require('node:assert/strict');

const loadHelpers = async () => import('../src/config/pythonTtsUrl.js');

test('canonical Render Python TTS hostname stays intact when building endpoint URLs', async () => {
  const { resolvePythonTtsBaseUrl, buildPythonTtsEndpoint } = await loadHelpers();
  const baseUrl = resolvePythonTtsBaseUrl({
    PYTHON_TTS_BASE_URL: 'https://technova-hub-voice-backend-python-82sv.onrender.com/',
    AI_SERVICE_HTTP: 'https://stale-host.onrender.comv'
  });
  const endpoint = new URL(buildPythonTtsEndpoint('/tts/broadcast', baseUrl));

  assert.equal(baseUrl, 'https://technova-hub-voice-backend-python-82sv.onrender.com');
  assert.equal(endpoint.hostname, 'technova-hub-voice-backend-python-82sv.onrender.com');
  assert.equal(endpoint.pathname, '/tts/broadcast');
  assert.equal(endpoint.href, 'https://technova-hub-voice-backend-python-82sv.onrender.com/tts/broadcast');
});

test('health endpoint is joined without adding characters to the configured hostname', async () => {
  const { buildPythonTtsEndpoint } = await loadHelpers();
  assert.equal(
    buildPythonTtsEndpoint('health', 'https://technova-hub-voice-backend-python-82sv.onrender.com'),
    'https://technova-hub-voice-backend-python-82sv.onrender.com/health'
  );
});

test('Python TTS URL ignores legacy generic service URL variables', async () => {
  const { resolvePythonTtsBaseUrl, getPythonTtsBaseUrls } = await loadHelpers();
  const env = {
    NODE_ENV: 'development',
    AI_SERVICE_HTTP: 'https://technova-hub-voice-backend-python-82sv.onrender.comv',
    PYTHON_TTS_SERVICE_URL: 'https://stale-python-service.onrender.com',
    PYTHON_TTS_URL: 'https://another-stale-service.onrender.com'
  };

  assert.equal(resolvePythonTtsBaseUrl(env), 'http://localhost:4000');
  assert.deepEqual(getPythonTtsBaseUrls(env), ['http://localhost:4000']);
});

test('malformed Render hostname and missing production setting fail clearly', async () => {
  const { resolvePythonTtsBaseUrl } = await loadHelpers();
  assert.throws(
    () => resolvePythonTtsBaseUrl({ PYTHON_TTS_BASE_URL: 'https://technova-hub-voice-backend-python-82sv.onrender.comv' }),
    /malformed Render hostname/
  );
  assert.throws(
    () => resolvePythonTtsBaseUrl({ NODE_ENV: 'production' }),
    /PYTHON_TTS_BASE_URL must be configured/
  );
  assert.throws(
    () => resolvePythonTtsBaseUrl({}),
    /PYTHON_TTS_BASE_URL must be configured/
  );
});

