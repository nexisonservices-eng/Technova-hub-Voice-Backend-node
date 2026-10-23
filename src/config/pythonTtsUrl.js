const DEFAULT_LOCAL_BASE_URL = 'http://localhost:4000';

const normalizeBaseUrl = (value) => {
  const candidate = String(value || '').trim();
  if (!candidate) return '';

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('PYTHON_TTS_BASE_URL must be a valid absolute URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
    throw new Error('PYTHON_TTS_BASE_URL must use HTTP(S) and cannot include query or fragment values');
  }
  if (parsed.username || parsed.password) {
    throw new Error('PYTHON_TTS_BASE_URL cannot include embedded credentials');
  }
  if (parsed.hostname.endsWith('.onrender.comv')) {
    throw new Error('PYTHON_TTS_BASE_URL has a malformed Render hostname; remove the trailing character after .onrender.com');
  }

  // Trim path separators without concatenating or otherwise editing the host.
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
};

export const resolvePythonTtsBaseUrl = (env = process.env) => {
  // Keep the Python TTS address on one explicit setting. AI_SERVICE_HTTP is
  // also used by other integrations and may contain an unrelated URL.
  const configured = normalizeBaseUrl(env.PYTHON_TTS_BASE_URL);
  if (configured) return configured;
  const runtimeEnvironment = String(env.NODE_ENV || '').trim().toLowerCase();
  if (runtimeEnvironment === 'development' || runtimeEnvironment === 'test') {
    return DEFAULT_LOCAL_BASE_URL;
  }
  throw new Error(
    'PYTHON_TTS_BASE_URL must be configured. For local development, set it to the running Python TTS service URL (default port 4000).'
  );
};

export const getPythonTtsBaseUrls = (env = process.env) => {
  return [resolvePythonTtsBaseUrl(env)];
};

export const buildPythonTtsEndpoint = (path, baseUrl = resolvePythonTtsBaseUrl()) => {
  const base = normalizeBaseUrl(baseUrl);
  const endpointPath = String(path || '').replace(/^\/+/, '');
  if (!base || !endpointPath) throw new Error('A Python TTS base URL and endpoint path are required');
  return new URL(endpointPath, `${base}/`).toString();
};

// Return only the origin and path for logs/diagnostics. Never include userinfo,
// query parameters, or fragments, even if a URL is supplied by another caller.
export const describePythonTtsEndpoint = (endpoint) => {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'configured-python-tts-endpoint';
  }
};

