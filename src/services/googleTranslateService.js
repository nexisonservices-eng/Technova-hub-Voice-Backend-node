import axios from 'axios';

const TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';
const tamilScript = /[\u0B80-\u0BFF]/;
const translationCache = new Map();
const MAX_CACHE_ENTRIES = 500;

/** Translate English speech text to Tamil, preserving text already in Tamil. */
export async function translateToTamilIfNeeded(value) {
  const text = String(value ?? '').trim();
  if (!text || tamilScript.test(text)) return text;

  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    throw new Error('Tamil translation is not configured: set GOOGLE_TRANSLATE_API_KEY.');
  }

  const cacheKey = text;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  try {
    const response = await axios.post(TRANSLATE_URL, null, {
      params: { q: text, source: 'en', target: 'ta', format: 'text', key: apiKey },
      timeout: 10000
    });
    const translated = response.data?.data?.translations?.[0]?.translatedText;
    if (typeof translated !== 'string' || !translated.trim()) {
      throw new Error('Google Translate returned an empty translation.');
    }

    const result = translated.trim();
    if (translationCache.size >= MAX_CACHE_ENTRIES) {
      translationCache.delete(translationCache.keys().next().value);
    }
    translationCache.set(cacheKey, result);
    return result;
  } catch (error) {
    const status = error?.response?.status;
    const reason = status ? `Google Translate request failed (HTTP ${status}).` : error.message;
    throw new Error(`Tamil translation failed: ${reason}`);
  }
}
