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

  // Trim path separators only. The hostname is never rewritten or concatenated.
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
};

export const resolvePythonTtsBaseUrl = (env = process.env) => {
  // PYTHON_TTS_BASE_URL is canonical. Legacy keys remain fallbacks for
  // deployments that have not yet moved their environment configuration.
  const configured = [
    env.PYTHON_TTS_BASE_URL,
    env.AI_SERVICE_HTTP,
    env.PYTHON_TTS_SERVICE_URL,
    env.PYTHON_TTS_URL
  ].find((value) => String(value || '').trim());

  return normalizeBaseUrl(configured) || DEFAULT_LOCAL_BASE_URL;
};

export const getPythonTtsBaseUrls = (env = process.env) => {
  const canonical = String(env.PYTHON_TTS_BASE_URL || '').trim();
  if (canonical) return [normalizeBaseUrl(canonical)];

  const legacyUrls = [...new Set([
    env.AI_SERVICE_HTTP,
    env.PYTHON_TTS_SERVICE_URL,
    env.PYTHON_TTS_URL
  ].map(normalizeBaseUrl).filter(Boolean))];
  return legacyUrls.length ? legacyUrls : [DEFAULT_LOCAL_BASE_URL];
};

export const buildPythonTtsEndpoint = (path, baseUrl = resolvePythonTtsBaseUrl()) => {
  const base = normalizeBaseUrl(baseUrl);
  const endpointPath = String(path || '').replace(/^\/+/, '');
  if (!base || !endpointPath) throw new Error('A Python TTS base URL and endpoint path are required');
  return new URL(endpointPath, `${base}/`).toString();
};

