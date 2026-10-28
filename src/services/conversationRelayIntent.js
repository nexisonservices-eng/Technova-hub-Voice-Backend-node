import { performance } from 'node:perf_hooks';
import { FAQ_ENTRIES, normalizeFaqQuestion, matchFaq, levenshteinDistance, isExplicitHumanHandoffRequest } from './conversationRelayFaq.js';

export const multilingualIntentEnabled = (env = process.env) => env.CONVERSATION_RELAY_MULTILINGUAL_NLP === 'true';

const aliases = new Map([
  ['service', 'services'], ['சர்வீசஸ்', 'services'], ['சர்வீஸ்', 'services'], ['சர்விசஸ்', 'services'],
  ['சேவைகள்', 'services'], ['சேவை', 'services'], ['sevies', 'services'], ['servis', 'services'],
  ['servises', 'services'], ['sevice', 'services'], ['ஆட்டோமேஷன்', 'automation'], ['ஆட்டோமேசன்', 'automation'],
  ['automtion', 'automation'], ['ஏஐ', 'ai'], ['ஏஐய', 'ai'], ['என்ன', 'enna'], ['என்னென்ன', 'enna'],
  ['என்றால்', 'na'], ['னா', 'na'], ['பற்றி', 'pathi'], ['பத்தி', 'pathi'],
  ['பண்றீங்க', 'pandringa'], ['செய்கிறீர்கள்', 'pandringa'], ['வழங்குகிறீர்கள்', 'pandringa'],
  ['panringa', 'pandringa'], ['panreenga', 'pandringa'], ['pannreenga', 'pandringa'],
  ['pandreenga', 'pandringa']
]);

const extraPatterns = {
  services: ['enna services pandringa', 'enna services', 'services enna', 'what services do you provide',
    'enna service pandringa', 'neenga enna services pandreenga', 'neenga enna service pandreenga',
    'neenga enna services panreenga', 'unga company enna pannum', 'unga company enna panum', 'company enna pannum',
    'can you tell me what services you provide', 'what are your services', 'tell me about your services',
    'what does your company actually do', 'what services can you provide to my business',
    'how can you help my business', 'neenga business ku enna help pannuveenga'],
  ai_automation: ['ai automation na enna', 'ai automation enna', 'automation na enna',
    'what is automation', 'explain ai automation', 'automation',
    'manual work reduce using ai', 'manual work ai vechu epdi reduce pannalam'],
  technovahub: ['what does technovahub do', 'what does technovahub actually do',
    'how can technovahub help my business'],
  human_representative: ['agent kitta connect pannunga', 'human kitta pesanum']
};

const canonicalize = (text) => normalizeFaqQuestion(String(text).normalize('NFKC'))
  .split(' ').map((word) => aliases.get(word) || word).join(' ')
  .replace(/^(?:(?:yeah|yes|okay|ok|please|hi|hello) )+/, '').replace(/ please$/, '');

export const detectTranscriptLanguage = (text) => {
  const value = typeof text === 'string' ? text : '';
  const tamil = /\p{Script=Tamil}/u.test(value);
  const latin = /[a-z]/i.test(value);
  if (tamil) return latin ? 'mixed-ta-latin' : 'ta';
  if (/\b(enna|pandringa|panringa|panreenga|pathi|sollunga|neenga|ungaloda|pannuveenga)\b/i.test(value)) return 'tanglish';
  return latin ? 'en-or-latin' : 'unknown';
};

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'about', 'actually', 'really', 'can', 'could', 'do', 'does', 'did', 'explain',
  'for', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'please', 'tell', 'that', 'the', 'this', 'to',
  'you', 'your', 'what', 'which', 'would', 'enna', 'na', 'neenga', 'ungaloda', 'pathi', 'sollunga', 'konjam', 'epdi', 'pannalam']);
const contentTokens = (text) => canonicalize(text).split(' ').filter((token) => token && !STOP_WORDS.has(token));
const intentPhrases = FAQ_ENTRIES.map((entry) => ({
  entry,
  phrases: [...new Set([...(entry.patterns || []), ...(extraPatterns[entry.id] || [])].map(canonicalize))]
}));
const directThreshold = (env = process.env) => {
  const configured = Number(env.CONVERSATION_RELAY_NLP_DIRECT_THRESHOLD);
  return Number.isFinite(configured) && configured >= 0.5 && configured <= 1 ? configured : 0.9;
};
const semanticThreshold = (env = process.env) => {
  const configured = Number(env.CONVERSATION_RELAY_NLP_SEMANTIC_THRESHOLD);
  return Number.isFinite(configured) && configured >= 0.5 && configured <= 1 ? configured : 0.72;
};
const handoffThreshold = (env = process.env) => {
  const configured = Number(env.CONVERSATION_RELAY_NLP_HANDOFF_THRESHOLD);
  return Number.isFinite(configured) && configured >= 0.9 && configured <= 1 ? configured : 0.98;
};

const levenshteinRepair = (text, entry, phrases) => {
  const tokens = text.split(' ');
  if (tokens.length < 3) return false;
  return phrases.some((phrase) => {
    const expected = phrase.split(' ');
    if (expected.length !== tokens.length) return false;
    const differences = tokens.map((token, index) => [token, expected[index]]).filter(([a, b]) => a !== b);
    if (differences.length !== 1) return false;
    const [actual, target] = differences[0];
    const critical = entry.id === 'services' ? 'services' : entry.id === 'ai_automation' ? 'automation' : null;
    return actual !== critical && target !== critical && /^[a-z]{5,24}$/.test(actual) && /^[a-z]{5,24}$/.test(target)
      && levenshteinDistance(actual, target) === 1;
  });
};

const similarity = (left, right) => {
  const a = new Set(contentTokens(left));
  const b = new Set(contentTokens(right));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  // Symmetric token Dice score; this is a retrieval score, not a probability.
  return (2 * overlap) / (a.size + b.size);
};

// Out-of-scope recognition is limited to the clear example topics approved
// for this agent. These phrase prototypes do not turn a failed FAQ match into
// an unrelated classification.
const unrelatedIntentPhrases = [
  { id: 'cricket_scores', phrases: ['cricket score', 'latest cricket scores', 'who won the cricket match'] },
  { id: 'movie_recommendation', phrases: ['recommend a movie', 'movie recommendations', 'what movie should i watch', 'suggest a film'] },
  { id: 'general_trivia', phrases: ['general trivia', 'tell me a trivia fact', 'ask me a trivia question'] }
].map(({ id, phrases }) => ({ id, phrases: phrases.map(canonicalize) }));
const OFF_TOPIC_THRESHOLD = 0.78;
const OFF_TOPIC_MARGIN = 0.15;
const COMPANY_CONTEXT = /\b(?:technovahub|nexion|company|companies|business solutions?|services?|service|ai automation)\b/i;
const OWNED_PRICING_OR_POLICY = /\b(?:your|our)\b.{0,24}\b(?:price|prices|pricing|cost|costs|quote|quotation|how much|policy|policies|refund|refunds|cancellation|cancellations|terms|warranty)\b/i;
const UNSUPPORTED_COMPANY_TOPIC = /\b(?:price|prices|pricing|cost|costs|quote|quotation|how much|policy|policies|refund|refunds|cancellation|cancellations|terms|warranty)\b/i;

const classifyUnmatchedQuestion = (text) => {
  // Explicit organization/service context takes priority over off-topic cues.
  if (COMPANY_CONTEXT.test(text) || OWNED_PRICING_OR_POLICY.test(text)) return 'company_unanswered';
  const candidates = unrelatedIntentPhrases.map(({ id, phrases }) => ({
    id, score: Math.max(...phrases.map((phrase) => similarity(text, phrase)), 0)
  })).sort((left, right) => right.score - left.score);
  const [best, next] = candidates;
  if (best?.score >= OFF_TOPIC_THRESHOLD
    && (!next || best.score - next.score >= OFF_TOPIC_MARGIN)) return 'unrelated';
  return 'unclear';
};

export const recognizeMultilingualIntent = (value, { env = process.env, providerLanguage = null } = {}) => {
  const started = performance.now();
  const valid = typeof value === 'string';
  const tooLong = valid && value.length > 3000;
  const source = valid ? value.normalize('NFKC').slice(0, 3000) : '';
  const normalizedText = normalizeFaqQuestion(source);
  const language = detectTranscriptLanguage(source);
  const sttLanguageHint = typeof providerLanguage === 'string'
    && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(providerLanguage) ? providerLanguage : null;
  const result = (faq, confidence, reason, fallbackReason = null, strategy = 'rules', threshold = directThreshold(env), classification = null) => ({
    faq, intent: faq?.intent || faq?.id?.toUpperCase() || null,
    classification: faq ? 'known_faq' : classification || 'unclear',
    confidence, scoreMeaning: confidence === null ? null : 'heuristic rule or token similarity score; not a calibrated probability',
    strategy, threshold, knowledgeId: faq?.id || null,
    entities: [...new Set((canonicalize(normalizedText).match(/\b(?:technovahub|nexion|ai)\b/g) || []))],
    reason, fallbackReason, language, sttLanguageHint, normalizedText,
    latencyMs: Number((performance.now() - started).toFixed(3))
  });
  if (!valid) return result(null, 0, 'invalid_transcript', 'non_string_transcript');
  if (tooLong) return result(null, 0, 'input_limit', 'transcript_too_long');
  if (!normalizedText) return result(null, 0, 'empty', 'empty_transcript');
  const text = canonicalize(normalizedText);
  const tokens = text.split(' ');
  if (tokens.length > 80) return result(null, 0, 'input_limit', 'too_many_tokens');
  const explicitHandoffRequest = isExplicitHumanHandoffRequest(source);
  if (UNSUPPORTED_COMPANY_TOPIC.test(text) && !explicitHandoffRequest) {
    const classification = classifyUnmatchedQuestion(text);
    const reason = /\b(?:price|prices|pricing|cost|costs|quote|quotation|how much)\b/i.test(text)
      ? 'unsupported_pricing' : 'unsupported_policy_or_company_detail';
    return result(null, 0, reason, 'no_approved_company_knowledge', 'rules', directThreshold(env), classification);
  }

  const greeting = FAQ_ENTRIES.find(({ id }) => id === 'greeting');
  if (/^(?:hello|hi|hey|good morning|good afternoon|good evening|vanakkam|வணக்கம்)(?: there)?[.!?\s]*$/i.test(source.trim())) {
    return result(greeting, 0.99, 'standalone_greeting', null, 'exact_phrase');
  }

  if (explicitHandoffRequest) {
    const faq = FAQ_ENTRIES.find(({ id }) => id === 'human_representative');
    const score = 0.99;
    const threshold = handoffThreshold(env);
    return score >= threshold
      ? result(faq, score, 'explicit_handoff_request', null, 'critical_rule', threshold)
      : result(null, score, 'below_handoff_threshold', 'low_confidence', 'critical_rule', threshold);
  }

  const goodbyeMention = /\b(?:goodbye|bye(?:\s+bye)?|hang up|end the call)\b/.test(text)
    || /நான் போகிறேன்|போயிட்டு வரேன்/.test(source);
  const explicitGoodbye = /^(?:(?:okay|ok|alright|thank you|thanks)\s+)*(?:goodbye|bye(?:\s+bye)?|good night|see you|நான் போகிறேன்|போயிட்டு வரேன்)[.!?\s]*$/i.test(text)
    || /^(?:(?:please|okay|ok|i want to|can you|could you|we can)\s+)*(?:hang up|end (?:the )?call)(?: please)?[.!?\s]*$/i.test(text);
  const negatedGoodbye = /\b(?:don't|dont|do not|not|never|no|cannot|can't|cant|won't|wont)\b.{0,32}\b(?:goodbye|bye|hang up|end the call)\b/.test(text)
    || /வேண்டாம்|இல்லை/.test(source);
  if (goodbyeMention && (!explicitGoodbye || negatedGoodbye)) {
    return result(null, 0, 'non_actionable_goodbye_mention', 'no_clear_call_termination', 'critical_rule');
  }
  if (explicitGoodbye) {
    const faq = matchFaq('goodbye');
    return result(faq, 0.99, 'explicit_goodbye', null, 'critical_rule');
  }

  const exact = [];
  for (const { entry, phrases } of intentPhrases) {
    if (entry.id === 'human_representative') continue;
    if (phrases.includes(text)) exact.push(entry);
  }
  const exactIds = [...new Set(exact.map(({ id }) => id))];
  if (exactIds.length === 1) {
    const score = 0.99;
    const threshold = directThreshold(env);
    return score >= threshold
      ? result(exact[0], score, 'configured_phrase', null, 'exact_phrase', threshold)
      : result(null, score, 'below_direct_threshold', 'low_confidence', 'exact_phrase', threshold);
  }
  if (exactIds.length > 1) return result(null, 0, 'ambiguous', 'conflicting_intents', 'exact_phrase');

  const legacy = matchFaq(normalizedText);
  if (legacy && !['human_representative', 'services', 'ai_automation'].includes(legacy.id)) {
    const entry = FAQ_ENTRIES.find(({ id }) => id === legacy.id) || legacy;
    const score = 0.95;
    const threshold = directThreshold(env);
    return score >= threshold
      ? result(entry, score, 'existing_faq_match', null, 'faq_rules', threshold)
      : result(null, score, 'below_direct_threshold', 'low_confidence', 'faq_rules', threshold);
  }
  if (legacy?.id === 'services') {
    const registry = intentPhrases.find(({ entry }) => entry.id === 'services');
    if (registry && levenshteinRepair(text, legacy, registry.phrases)) {
      const score = 0.9;
      const threshold = directThreshold(env);
      return score >= threshold
        ? result(legacy, score, 'bounded_phrase_similarity', null, 'bounded_edit_distance', threshold)
        : result(null, score, 'below_direct_threshold', 'low_confidence', 'bounded_edit_distance', threshold);
    }
  }

  const candidates = intentPhrases.filter(({ entry }) => !['human_representative', 'thanks'].includes(entry.id))
    .map(({ entry, phrases }) => ({
      entry,
      score: Math.max(...phrases.map((phrase) => similarity(text, phrase)), 0)
    })).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const next = candidates[1];
  const threshold = semanticThreshold(env);
  if (best?.score >= threshold && (!next || best.score - next.score >= 0.12)) {
    return result(best.entry, Number(best.score.toFixed(3)), 'semantic_retrieval', null, 'faq_token_similarity', threshold);
  }
  const weakScore = best?.score > 0;
  const ambiguous = best?.score >= threshold;
  const classification = ambiguous ? 'unclear' : classifyUnmatchedQuestion(text);
  return result(null, best?.score ? Number(best.score.toFixed(3)) : 0,
    ambiguous ? 'ambiguous' : weakScore ? 'low_confidence' : 'no_reliable_match',
    ambiguous ? 'conflicting_intents' : weakScore ? 'low_confidence' : 'no_supported_phrase', 'none', threshold, classification);
};

export const resolveConversationRelayIntent = (value, {
  enabled = multilingualIntentEnabled(), recognizer = recognizeMultilingualIntent, providerLanguage = null
} = {}) => {
  if (!enabled) return { faq: matchFaq(value), reason: 'feature_disabled' };
  try { return recognizer(value, { providerLanguage }); }
  catch {
    const faq = matchFaq(value);
    return {
      faq, classification: faq ? 'known_faq' : 'unclear', confidence: null,
      reason: 'legacy_faq_fallback', fallbackReason: 'recognizer_error'
    };
  }
};

export const intentDiagnostic = (recognition) => ({
  processingStage: 'intent_recognition', strategy: recognition.strategy || null,
  classification: recognition.classification || null,
  detectedLanguage: recognition.language || 'unknown', sttLanguageHint: recognition.sttLanguageHint || null,
  intent: recognition.intent || null,
  confidence: recognition.confidence ?? null, scoreMeaning: recognition.scoreMeaning || null,
  threshold: recognition.threshold ?? null, knowledgeId: recognition.knowledgeId || null,
  entities: recognition.entities || [],
  reason: recognition.reason, fallbackReason: recognition.fallbackReason || null,
  processingLatencyMs: recognition.latencyMs ?? null,
  normalizedText: '[omitted]'
});
