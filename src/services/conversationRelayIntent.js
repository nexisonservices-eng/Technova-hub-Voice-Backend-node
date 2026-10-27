import { performance } from 'node:perf_hooks';
import { FAQ_ENTRIES, normalizeFaqQuestion, matchFaq, levenshteinDistance } from './conversationRelayFaq.js';

export const multilingualIntentEnabled = (env = process.env) => env.CONVERSATION_RELAY_MULTILINGUAL_NLP === 'true';

const aliases = new Map([
  ['service', 'services'], ['சர்வீசஸ்', 'services'], ['சர்வீஸ்', 'services'], ['சர்விசஸ்', 'services'],
  ['சேவைகள்', 'services'], ['சேவை', 'services'], ['sevies', 'services'], ['servis', 'services'],
  ['servises', 'services'], ['sevice', 'services'],
  ['ஆட்டோமேஷன்', 'automation'], ['ஆட்டோமேசன்', 'automation'], ['automtion', 'automation'],
  ['ஏஐ', 'ai'], ['ஏஐய', 'ai'], ['என்ன', 'enna'], ['என்னென்ன', 'enna'],
  ['என்றால்', 'na'], ['னா', 'na'], ['பற்றி', 'pathi'], ['பத்தி', 'pathi'],
  ['பண்றீங்க', 'pandringa'], ['செய்கிறீர்கள்', 'pandringa'], ['வழங்குகிறீர்கள்', 'pandringa'],
  ['panringa', 'pandringa'], ['panreenga', 'pandringa'], ['pannreenga', 'pandringa']
]);
const canonicalize = (text) => normalizeFaqQuestion(text).split(' ').map((word) => aliases.get(word) || word)
  .join(' ').replace(/^(?:(?:yeah|yes|okay|ok|please|hi|hello) )+/, '').replace(/ please$/, '');
const extraPatterns = {
  services: ['enna services pandringa', 'enna services', 'services enna', 'what services do you provide',
    'can you tell me what services you provide', 'what are your services', 'tell me about your services'],
  ai_automation: ['ai automation na enna', 'ai automation enna', 'automation na enna',
    'what is automation', 'explain ai automation', 'automation']
};
const patterns = ['services', 'ai_automation'].map((id) => ({
  id, phrases: [...new Set([...FAQ_ENTRIES.find((entry) => entry.id === id).patterns, ...extraPatterns[id]]
    .map(canonicalize))]
}));

export const detectTranscriptLanguage = (text) => {
  const tamil = /\p{Script=Tamil}/u.test(text);
  const latin = /[a-z]/i.test(text);
  if (tamil) return latin ? 'mixed-ta-latin' : 'ta';
  if (/\b(enna|pandringa|panringa|panreenga|pathi|sollunga|neenga|ungaloda)\b/i.test(text)) return 'tanglish';
  return latin ? 'en-or-latin' : 'unknown';
};

// Intents only: answers and all state transitions remain owned by the FAQ module.
// Confidence is a rule score, not a calibrated statistical probability.
export const recognizeMultilingualIntent = (value) => {
  const started = performance.now();
  const normalizedText = normalizeFaqQuestion(String(value || '').slice(0, 3000));
  const language = detectTranscriptLanguage(normalizedText);
  const result = (faq, confidence, reason, fallbackReason = null) => ({
    faq, intent: faq?.intent || faq?.id?.toUpperCase() || null,
    confidence, reason, fallbackReason, language, normalizedText,
    latencyMs: Number((performance.now() - started).toFixed(3))
  });
  if (!normalizedText) return result(null, 0, 'empty', 'empty_transcript');
  const text = canonicalize(normalizedText);
  const tokens = text.split(' ');
  if (tokens.length > 80) return result(null, 0, 'input_limit', 'too_many_tokens');
  const candidates = [];
  for (const { id, phrases } of patterns) {
    const anchor = id === 'services' ? 'services' : 'automation';
    // Similarity may repair one non-topic Latin word only. Topic words must
    // match an explicit alias; arbitrary words like "servants" cannot qualify.
    if (!tokens.includes(anchor)) continue;
    for (const phrase of phrases) {
      if (text === phrase) { candidates.push({ id, confidence: 0.99, reason: 'configured_phrase' }); break; }
      const expected = phrase.split(' ');
      if (tokens.length < 3 || expected.length !== tokens.length) continue;
      const differences = tokens.map((token, i) => [token, expected[i]]).filter(([a, b]) => a !== b);
      if (differences.length === 1) {
        const [a, b] = differences[0];
        if (a !== anchor && b !== anchor && /^[a-z]{5,24}$/.test(a) && /^[a-z]{5,24}$/.test(b)
          && levenshteinDistance(a, b) === 1) candidates.push({ id, confidence: 0.9, reason: 'bounded_phrase_similarity' });
      }
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  if (candidates.length && !candidates.some((c) => c.id !== candidates[0].id)) {
    const best = candidates[0];
    return result(FAQ_ENTRIES.find((entry) => entry.id === best.id), best.confidence, best.reason);
  }
  if (candidates.length) return result(null, 0, 'ambiguous', 'conflicting_intents');
  // Preserve the other configured FAQs via the existing matcher. Gate the two
  // enhanced topics so its broad edit-distance heuristic cannot bypass rejection.
  const legacy = matchFaq(normalizedText);
  if (legacy && !['services', 'ai_automation'].includes(legacy.id)) return result(legacy, 0.8, 'legacy_faq_fallback');
  return result(null, 0, 'no_reliable_match', 'no_supported_phrase');
};

export const resolveConversationRelayIntent = (value, { enabled = multilingualIntentEnabled(), recognizer = recognizeMultilingualIntent } = {}) => {
  if (!enabled) return { faq: matchFaq(value), reason: 'feature_disabled' };
  try { return recognizer(value); }
  catch {
    return { faq: matchFaq(value), confidence: null, reason: 'legacy_faq_fallback', fallbackReason: 'recognizer_error' };
  }
};

// Only allowlisted vocabulary is logged. Redacting phone/email patterns alone
// cannot protect names, addresses or secrets embedded in normalized prose.
const diagnosticVocabulary = new Set(patterns.flatMap(({ phrases }) => phrases.flatMap((phrase) => phrase.split(' '))));
export const intentDiagnostic = (recognition) => ({
  detectedLanguage: recognition.language || 'unknown', intent: recognition.intent || null,
  confidence: recognition.confidence ?? null, reason: recognition.reason,
  fallbackReason: recognition.fallbackReason || null, processingLatencyMs: recognition.latencyMs ?? null,
  normalizedText: canonicalize(recognition.normalizedText || '').split(' ')
    .map((token) => diagnosticVocabulary.has(token) ? token : '[redacted]').join(' ').slice(0, 300)
});
