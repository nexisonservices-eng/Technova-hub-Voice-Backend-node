const LOCAL_AI_URL = 'http://localhost:4000';

export const resolveConversationAIBaseUrl = (env = process.env) => {
  const candidates = [env.AI_SERVICE_HTTP, env.PYTHON_TTS_BASE_URL]
    .map((value) => String(value || '').trim()).filter(Boolean);
  if (!candidates.length) {
    if (['development', 'test'].includes(String(env.NODE_ENV || '').toLowerCase())) return LOCAL_AI_URL;
    throw new Error('AI_SERVICE_HTTP or PYTHON_TTS_BASE_URL must point to the Python AI service');
  }

  const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
  let lastError = null;
  for (const candidate of candidates) {
    let url;
    try { url = new URL(candidate); } catch { lastError = new Error('Python AI service URL must be an absolute HTTP(S) URL'); continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      lastError = new Error('Python AI service URL must use HTTP(S) without embedded credentials, query, or fragment');
      continue;
    }
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
    if (production && isLoopback) {
      lastError = new Error('Python AI service URL must be publicly reachable from the production Node service');
      continue;
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  }
  throw lastError || new Error('Python AI service URL is not configured');
};

export const describeConversationAIEndpoint = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch { return 'unconfigured-python-ai-endpoint'; }
};
