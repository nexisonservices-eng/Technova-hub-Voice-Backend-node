export const FAQ_WELCOME = 'வணக்கம்! TechnovaHub-க்கு வெல்கம். நான் உங்களோட AI ஹெல்ப்பர். உங்களுக்கு எப்படி ஹெல்ப் பண்ணலாம்?';

const TAMIL_NEXION_NAMES = [
  '\u0ba8\u0bc6\u0b95\u0bcd\u0b9a\u0bbf\u0baf\u0ba9\u0bcd', // நெக்சியன்
  '\u0ba8\u0bc6\u0b95\u0bcd\u0bb8\u0bbf\u0baf\u0ba9\u0bcd', // நெக்ஸியன்
  '\u0ba8\u0bc6\u0b95\u0bcd\u0bb7\u0bbf\u0baf\u0ba9\u0bcd'  // நெக்ஷியன்
];

const TAMIL_NEXION_QUESTION_PATTERNS = [
  'nexion \u0b8e\u0ba9\u0bcd\u0bb1\u0bbe\u0bb2\u0bcd \u0b8e\u0ba9\u0bcd\u0ba9', // என்றால் என்ன
  'nexion \u0baa\u0bb1\u0bcd\u0bb1\u0bbf \u0b9a\u0bca\u0bb2\u0bcd\u0bb2\u0bc1\u0b99\u0bcd\u0b95', // பற்றி சொல்லுங்க
  'nexion \u0baa\u0bb1\u0bcd\u0bb1\u0bbf \u0b9a\u0bca\u0bb2\u0bcd\u0bb2\u0bc1\u0b99\u0bcd\u0b95\u0bb3\u0bcd', // பற்றி சொல்லுங்கள்
  'nexion \u0b8e\u0ba9\u0bcd\u0ba9 \u0b9a\u0bc6\u0baf\u0bcd\u0baf\u0bc1\u0bae\u0bcd', // என்ன செய்யும்
  'nexion \u0b8e\u0ba9\u0bcd\u0ba9 \u0baa\u0ba3\u0bcd\u0ba3\u0bc1\u0bae\u0bcd' // என்ன பண்ணும்
];

export const FAQ_ENTRIES = Object.freeze([
  {
    id: 'greeting',
    intent: 'GREETING',
    answer: FAQ_WELCOME,
    patterns: ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening', 'வணக்கம்', 'vanakkam']
  },
  {
    id: 'ai_automation',
    intent: 'AI_AUTOMATION',
    answer: 'எங்களோட AI ஆட்டோமேஷன் சர்வீசஸ்க்கு சில ஸ்பெஷல் ஆஃபர்ஸ் இருக்கு. அதைப் பத்தி இன்னும் டீடெயிலா தெரிஞ்சிக்க உங்களை எங்க டீம் கூட கனெக்ட் பண்ணட்டுமா?',
    patterns: [
      'what is ai automation', 'what is artificial intelligence automation', 'tell me about ai automation', 'ai automation services',
      'ai automation na enna', 'ai automation pathi', 'ai automation services na enna', 'ai automation services enna pannum',
      'ai automation enna pannum', 'ai automation pathi sollunga', 'ai automation pathi sollunga',
      'AI ஆட்டோமேஷன் என்ன', 'AI ஆட்டோமேஷன் பத்தி', 'ஆட்டோமேஷன் சர்வீசஸ் என்ன', 'AI ஆட்டோமேஷன் சர்வீசஸ்'
    ]
  },
  {
    id: 'technovahub',
    answer: 'TechnovaHub என்பது நிறுவனங்களுக்கு IT Services, AI Automation மற்றும் Digital Transformation Solutions வழங்கும் ஒரு தொழில்நுட்ப நிறுவனம்.',
    patterns: ['what is technovahub', 'whats technovahub', 'tell me about technovahub', 'explain technovahub', 'technovahub na enna', 'technovahub என்றால் என்ன', 'technovahub என்ன', 'technovahub pathi']
  },
  {
    id: 'services',
    intent: 'COMPANY_SERVICES',
    answer: 'நம்ம TechnovaHub-ல IT சர்வீசஸ், AI ஆட்டோமேஷன், டிஜிட்டல் டிரான்ஸ்ஃபர்மேஷன் சர்வீசஸ் எல்லாம் பண்ணிட்டு இருக்கோம்.',
    patterns: ['what services', 'which services', 'services do you provide', 'services do you offer', 'what do you provide', 'what do you offer', 'what do you do', 'என்னென்ன சேவைகள்', 'என்ன சேவைகள்', 'என்னென்ன சர்வீசஸ்', 'சர்வீசஸ் என்ன', 'என்னென்ன services பண்றீங்க', 'என்னென்ன services வழங்குறீங்க', 'services வழங்குறீங்க', 'enna services', 'enna service', 'services enna', 'services provide', 'services offer', 'enna services pandringa', 'enna services panringa', 'what services are you doing', 'what services does technovahub provide']
  },
  {
    id: 'nexion',
    answer: 'Nexion என்பது TechnovaHub உருவாக்கிய ஒரு Business Automation Platform. இது நிறுவனங்களின் தினசரி வேலைகளை எளிமையாக்கவும், மீண்டும் மீண்டும் செய்யப்படும் வேலைகளை தானியங்குபடுத்தவும், நேரத்தை மிச்சப்படுத்தவும் உதவுகிறது.',
    patterns: [
      'what is nexion', 'whats nexion', 'what is nexian', 'tell me about nexion', 'tell me about nexian', 'explain nexion', 'explain nexian', 'what does nexion do',
      'nexion na enna', 'nexion enna', 'nexion enna pannum', 'nexion pathi', 'nexion pathi sollunga',
      'nexion pathi sollungal', 'nexion என்றால் என்ன', 'nexion பற்றி சொல்லுங்க', 'nexion பற்றி சொல்லுங்கள்',
      'nexion என்ன செய்யும்', 'nexion என்ன பண்ணும்', ...TAMIL_NEXION_QUESTION_PATTERNS
    ]
  },
  {
    id: 'repetitive_tasks',
    answer: 'ஆம். Nexion மீண்டும் மீண்டும் செய்யப்படும் வேலைகளைத் தானியங்குபடுத்தவும் அன்றாட பணிகளை எளிமையாக்கவும் வடிவமைக்கப்பட்டுள்ளது.',
    patterns: ['automate repetitive tasks', 'automate repeated tasks', 'automate tasks', 'repetitive tasks automate', 'can nexion automate', 'repeat tasks automate', 'திரும்பத் திரும்ப செய்யும் பணிகள்', 'repetitive work automate']
  },
  {
    id: 'nexion_benefits',
    answer: 'Nexion மூலம் நிறுவனங்கள் நேரத்தை மிச்சப்படுத்தலாம், தினசரி வேலைகளை எளிமையாக்கலாம், முக்கியமான செயல்முறைகளை இணைக்கலாம் மற்றும் தொழில் வளர்ச்சியில் அதிக கவனம் செலுத்தலாம்.',
    patterns: ['how does nexion help', 'how can nexion help', 'what are the benefits', 'nexion benefits', 'benefits of nexion', 'how nexion works', 'nexion use enna', 'nexion epdi help', 'nexion eppadi help', 'nexion epdi work', 'nexion எப்படி உதவும்', 'nexion நன்மைகள்']
  },
  {
    id: 'businesses',
    answer: 'எங்கள் தீர்வுகளை Startups, Retail, Manufacturing, Financial Services உள்ளிட்ட பல்வேறு துறைகளில் உள்ள சிறு, நடுத்தர மற்றும் பெரிய நிறுவனங்கள் பயன்படுத்தலாம்.',
    patterns: ['which businesses', 'what businesses', 'who can use', 'which industries', 'what industries', 'industries can use', 'who are these solutions for', 'small businesses use', 'எந்த நிறுவனங்கள்', 'யார் பயன்படுத்தலாம்', 'entha business', 'yaar use pannalaam', 'businesses use pannalaam']
  },
  {
    id: 'offers',
    answer: 'எங்களுடைய தற்போதைய சலுகைகள் பற்றி தெரிந்துகொள்ள எங்கள் குழுவினருடன் பேச விரும்புகிறீர்களா?',
    patterns: ['discount', 'special offer', 'special offers', 'any offers', 'current offers', 'promotion', 'rebate', 'சலுகை', 'offer iruka', 'discount iruka', 'offer irukkaa', 'offers irukka']
  },
  {
    id: 'human_representative',
    answer: 'நிச்சயமாக! உங்களை எங்கள் குழுவினருடன் இணைக்கிறேன்.',
    patterns: ['speak to a human', 'speak with a human', 'human representative', 'talk to a person', 'speak to a person', 'talk to someone', 'connect me to a human', 'representative', 'live agent', 'human support', 'team kitta pesanum', 'oru person kitta', 'மனிதரிடம் பேச', 'பிரதிநிதியிடம் பேச']
  },
  {
    id: 'contact',
    answer: 'TechnovaHub-ஐ +91 90035 30230 என்ற எண்ணில் தொடர்பு கொள்ளலாம் அல்லது www.technovahub.in இணையதளத்தைப் பார்வையிடலாம்.',
    patterns: ['contact technovahub', 'contact number', 'phone number', 'how can i contact', 'how to contact', 'website', 'web site', 'contact details', 'எப்படி தொடர்பு', 'contact epdi', 'phone number enna']
  },
  {
    id: 'thanks',
    answer: 'மிக்க நன்றி! வேறு ஏதாவது உதவி தேவையா?',
    patterns: ['thank you', 'thanks', 'நன்றி', 'nandri', 'romba thanks']
  }
]);

export const FAQ_RESPONSES = Object.freeze({
  unknown: 'மன்னிக்கவும், அந்தத் தகவல் இப்போது என்னிடம் இல்லை. எங்கள் குழுவினருடன் பேச விரும்புகிறீர்களா?',
  unrelatedRedirect: 'மன்னிக்கவும், நான் TechnovaHub பற்றிய கேள்விகளுக்கு உதவுகிறேன். அதன் சேவைகள் அல்லது நிறுவனத்தைப் பற்றி கேட்க விரும்புகிறீர்களா?',
  clarifyQuestion: 'மன்னிக்கவும், உங்கள் கேள்வியைச் சரியாகப் புரிந்துகொள்ளவில்லை. தயவுசெய்து மீண்டும் சொல்ல முடியுமா?',
  noTransfer: 'பரவாயில்லை. வேறு எந்தக் கேள்விக்கு உதவலாம்?',
  clarifyTransfer: 'மன்னிக்கவும், புரியவில்லை. ஆம் அல்லது இல்லை என்று சொல்லுங்கள்; அல்லது உங்கள் கேள்வியை மீண்டும் கேளுங்கள்.',
  unavailable: 'மன்னிக்கவும், இப்போது எங்கள் குழுவினருடன் இணைக்க முடியவில்லை. வேறு எப்படியாவது உதவட்டுமா?',
  goodbye: 'TechnovaHub-ஐ தொடர்பு கொண்டதற்கு நன்றி. இனிய நாளாக அமையட்டும்!'
});

const normalize = (value) => String(value || '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[’']/g, '')
  // Tamil vowel signs and virama are Unicode marks, not letters. Preserve
  // combining marks during cleanup so Tamil names and suffixes stay intact.
  .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\bnexian\b/g, 'nexion')
  .replace(/\bnexon\b/g, 'nexion');

export const normalizeFaqQuestion = (value) => {
  let text = normalize(value);
  for (const tamilName of TAMIL_NEXION_NAMES) text = text.replaceAll(tamilName, 'nexion');
  // Observed STT: "automationальна". Recover the complete configured keyword
  // only when a short Cyrillic suffix is attached. Do not strip other scripts
  // globally or match arbitrary Latin words containing "automation".
  return text.split(' ').map((token) => /^automation\p{Script=Cyrillic}{1,8}$/u.test(token)
    ? 'automation' : token).join(' ');
};

export const extractConversationRelayTranscription = (message) =>
  message?.type === 'prompt' && typeof message.voicePrompt === 'string'
    ? message.voicePrompt.trim().slice(0, 3000)
    : '';

export const redactFaqDiagnosticText = (value) => String(value || '')
  .replace(/\b(?:bearer|basic)\s+\S+/gi, '[credential]')
  .replace(/\b(?:auth[\s_-]*token|access[\s_-]*token|api[\s_-]*key|password|secret)\s*[:=]?\s*\S+/gi, '[credential]')
  .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/g, '[credential]')
  .replace(/\b[a-f0-9]{32,}\b/gi, '[credential]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
  .replace(/https?:\/\/\S+/gi, '[url]')
  .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
  .slice(0, 300);

const containsAny = (text, phrases) => phrases.some((phrase) => text.includes(normalize(phrase)));
export const levenshteinDistance = (left, right) => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[right.length];
};

const isServiceToken = (token) => {
  if (['service', 'services', 'sevies', 'servis', 'servises', 'sevice', 'சர்வீசஸ்', 'சர்வீஸ்', 'சர்விசஸ்', 'சேவைகள்', 'சேவை'].includes(token)) return true;
  return token.length >= 6 && Math.abs(token.length - 8) <= 2 && levenshteinDistance(token, 'services') <= 2;
};

const isServiceActivityToken = (token) => [
  'provide', 'provides', 'offering', 'offer', 'offers', 'doing', 'do', 'pandringa', 'pandringe',
  'panringa', 'panreenga', 'panreenga', 'pannreenga', 'apndrings', 'apandrings', 'pandrings',
  'பண்றீங்க', 'பண்ணுறீங்க', 'பண்ணறீங்க', 'வழங்குறீங்க', 'வழங்குகிறீர்கள்'
].includes(token);

const isCompanyServicesQuestion = (text) => {
  const tokens = text.split(' ').filter(Boolean);
  const tokenSet = new Set(tokens);
  const tamilOrTanglishQuestion = ['enna', 'neenga', 'ungaloda', 'ungal', 'என்ன', 'என்னென்ன', 'நீங்க', 'உங்களோட'].some((token) => tokenSet.has(token));
  const englishQuestion = ['what', 'which', 'provide', 'offer', 'services'].some((token) => tokenSet.has(token));
  const hasService = tokens.some(isServiceToken);
  const hasQuestionMarker = tamilOrTanglishQuestion || tokenSet.has('what') || tokenSet.has('which');
  const hasActivity = tokens.some(isServiceActivityToken);
  const asksAboutWork = tokenSet.has('vela') && tamilOrTanglishQuestion && hasActivity;
  const asksWhat = ['enna', 'என்ன', 'என்னென்ன'].some((token) => tokenSet.has(token));
  const asksWhatCompanyDoes = tokenSet.has('company') && asksWhat
    && ['pannum', 'panum', 'does', 'do'].some((token) => tokenSet.has(token));
  return (hasService && hasQuestionMarker && (hasActivity || englishQuestion || asksWhat)) || asksAboutWork || asksWhatCompanyDoes;
};

const isAutomationToken = (token) => ['automation', 'automtion', 'ஆட்டோமேஷன்', 'ஆட்டோமேசன்'].includes(token);

const isAiAutomationQuestion = (text) => {
  const tokens = text.split(' ').filter(Boolean);
  const tokenSet = new Set(tokens);
  const hasAi = ['ai', 'ஏஐ', 'ஏஐய', 'ஐ'].some((token) => tokenSet.has(token));
  const hasAutomation = tokens.some(isAutomationToken);
  const hasServiceContext = tokens.some((token) => isServiceToken(token));
  const hasQuestionCue = ['enna', 'na', 'what', 'about', 'pathi', 'என்ன', 'னா', 'பத்தி'].some((token) => tokenSet.has(token));
  // A short topic-only reply (including the reported "Yeah, automation...")
  // requests this configured FAQ. "Yeah" alone remains a confirmation, and
  // unrelated subjects such as "payroll automation" do not gain a match.
  const shortTopic = tokens.length <= 3 && tokens.every((token) =>
    isAutomationToken(token) || ['yeah', 'yes', 'ok', 'okay'].includes(token));
  return hasAutomation && (hasAi || hasServiceContext || hasQuestionCue || shortTopic);
};

const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'okay', 'ok', 'sure', 'interested', 'venum', 'aamam', 'aama', 'sari']);
const NO_WORDS = new Set(['no', 'nope', 'illa', 'vendam']);

export const classifyConfirmation = (value) => {
  const text = normalize(value);
  if (/\bnot interested\b/.test(text)) return 'no';
  const words = text.split(' ');
  const yes = words.some((word) => YES_WORDS.has(word)) || /ஆமாம்|ஆமா|சரி/.test(text);
  const no = words.some((word) => NO_WORDS.has(word)) || /வேண்டாம்|இல்லை/.test(text);
  if (yes === no) return 'unclear';
  return yes ? 'yes' : 'no';
};

// Optional NLP mode accepts consent only as a complete reply. Never infer
// consent from an affirmative embedded in an unrecognized customer question.
export const isStandaloneConfirmation = (value) => {
  const text = normalize(value);
  if (text === 'not interested') return true;
  const words = text.split(' ');
  return words.length <= 4 && words.every((word) => YES_WORDS.has(word) || NO_WORDS.has(word)
    || ['ஆமாம்', 'ஆமா', 'சரி', 'வேண்டாம்', 'இல்லை', 'please', 'thanks', 'thank', 'you'].includes(word));
};

export const matchFaq = (value) => {
  const text = normalizeFaqQuestion(value);
  if (!text) return null;
  if (containsAny(text, ['goodbye', 'bye bye', 'bye', 'hang up', 'end the call', 'நான் போகிறேன்', 'போயிட்டு வரேன்'])) {
    return { id: 'goodbye', answer: FAQ_RESPONSES.goodbye, endCall: true };
  }
  if (containsAny(text, ['thank you', 'thanks', 'நன்றி', 'nandri', 'romba thanks']) && text.split(' ').length <= 5) {
    return FAQ_ENTRIES.find(({ id }) => id === 'thanks');
  }

  const automationEntry = FAQ_ENTRIES.find(({ id }) => id === 'ai_automation');
  const isAutomation = isAiAutomationQuestion(text) || containsAny(text, automationEntry.patterns);
  if (!isAutomation && isCompanyServicesQuestion(text)) return FAQ_ENTRIES.find(({ id }) => id === 'services');
  if (isAutomation) return automationEntry;
  const humanEntry = FAQ_ENTRIES.find(({ id }) => id === 'human_representative');
  if (containsAny(text, humanEntry.patterns)) return humanEntry;

  const remainingPriority = ['offers', 'repetitive_tasks', 'nexion_benefits', 'businesses', 'contact', 'services', 'nexion', 'technovahub'];
  for (const id of remainingPriority) {
    const entry = FAQ_ENTRIES.find((candidate) => candidate.id === id);
    if (containsAny(text, entry.patterns)) return entry;
  }
  return null;
};

// Keep transfer selection tied to an affirmative request verb and a human
// destination. Mentioning a person or representative alone is not consent.
export const isExplicitHumanHandoffRequest = (value) => {
  const text = normalizeFaqQuestion(value);
  const englishRequest = /\b(?:speak|talk)\s+(?:to|with)\s+(?:(?:a|the)\s+)?(?:human|agent|representative|person|someone|team|live agent)\b/.test(text)
    || /\b(?:connect|transfer)\s+(?:(?:me|us)\s+)?(?:to|with)\s+(?:(?:a|the)\s+)?(?:human|agent|representative|person|someone|team)\b/.test(text);
  const tamilOrTanglishRequest = /\b(?:human|agent|representative|person|team)\s+kitta\s+(?:pesanum|pesanum|connect\s+pannunga)\b/.test(text)
    || /(?:மனிதரிடம்|பிரதிநிதியிடம்)\s*பேச(?:வும்|ணும்|வேண்டும்)?/.test(text)
    || /(?:மனிதர்|பிரதிநிதி).{0,24}(?:இணைக்கவும்|கனெக்ட்|பேசணும்|பேச வேண்டும்)/.test(text);
  const requestsHandoff = englishRequest || tamilOrTanglishRequest;
  const negatesRequest = /\b(don't|dont|do not|not|never|no|cannot|can't|cant|won't|wont|vendam|illa)\b/.test(text)
    || /வேண்டாம்|இல்லை/.test(text);
  return requestsHandoff && !negatesRequest;
};

export const createFaqState = (callSid = '') => ({
  callSid: String(callSid || ''),
  stage: 'awaiting_question',
  awaitingHumanConfirmation: false,
  awaitingAutomationConfirmation: false,
  turns: 0,
  // Per-call context stores only a FAQ identifier and timestamp, never caller text.
  lastFaqId: null,
  lastFaqAt: null
});

const contextualFollowUp = (value) => {
  const text = normalizeFaqQuestion(value);
  if (/\b(repeat|again|say that again|tell me more|explain that|explain it|first one|second one|that one|the same|first services?|second services?)\b/.test(text)
    || /\b(adhai|atha|idha|idhai|thirumba|mudhal|muthal|konjam explain)\b/.test(text)
    || /மீண்டும்|அதை|அதற்கு|முதல் ஒன்றை|விளக்குங்கள்/.test(text)) return 'previous_answer';
  return null;
};

// Resolve common anaphoric follow-ups against the last approved topic. Keep
// answers deliberately bounded: pricing is not present in the approved FAQ,
// while workflow details depend on the caller's systems and requirements.
const contextualAutomationFollowUp = (value) => {
  const text = normalizeFaqQuestion(value);
  if (/\b(?:price|pricing|cost|how much|evlo|selavu|vilai)\b/.test(text)) {
    return {
      faqId: 'ai_automation_pricing',
      answer: 'AI automation pricing depends on the workflow and integrations, and I do not have an approved price to quote. Would you like me to connect you with our team?'
    };
  }
  if (/\b(?:benefit|benefits|useful|usefulness|business ku|business-ku|advantage|value)\b/.test(text)) {
    return {
      faqId: 'ai_automation_benefits',
      answer: 'In general, AI automation can reduce repetitive manual steps and make routine processes more consistent. The right benefits depend on your business workflow. Would you like to discuss your use case with our team?'
    };
  }
  if (/\b(?:how|epdi|work|works|working|function|operate)\b/.test(text)) {
    return {
      faqId: 'ai_automation_how_it_works',
      answer: 'In general, AI automation uses software and AI to handle routine steps in a workflow. The exact setup depends on the task and the systems involved. Would you like to discuss a specific process with our team?'
    };
  }
  return null;
};

export const processFaqPrompt = (state, prompt, {
  transferAvailable, matcher = matchFaq, strictConfirmation = false, contextEnabled = strictConfirmation,
  classification = null
}) => {
  if (state.stage !== 'awaiting_question') return { action: 'ignored' };
  const text = String(prompt || '').trim().slice(0, 3000);
  state.turns += 1;
  let faq = matcher(text);
  let contextResolution = null;
  const followUp = contextualFollowUp(text);
  const previousFaqIsFresh = state.lastFaqId && Number.isFinite(state.lastFaqAt)
    && Date.now() - state.lastFaqAt <= 5 * 60 * 1000;
  if (contextEnabled && state.lastFaqId === 'ai_automation' && previousFaqIsFresh
    && !isStandaloneConfirmation(text) && !isExplicitHumanHandoffRequest(text)) {
    const contextualAnswer = contextualAutomationFollowUp(text);
    if (contextualAnswer) {
      state.awaitingAutomationConfirmation = false;
      state.awaitingHumanConfirmation = true;
      state.lastFaqId = 'ai_automation';
      state.lastFaqAt = Date.now();
      return { action: 'answer', ...contextualAnswer, contextResolution: 'ai_automation_follow_up' };
    }
  }
  if (contextEnabled && classification !== 'unrelated' && classification !== 'company_unanswered'
    && !faq && followUp && previousFaqIsFresh
    && !state.awaitingHumanConfirmation && !state.awaitingAutomationConfirmation) {
    faq = FAQ_ENTRIES.find(({ id }) => id === state.lastFaqId) || null;
    if (faq) contextResolution = 'previous_approved_answer_repeated';
  }
  const confirmation = strictConfirmation && !isStandaloneConfirmation(text) ? 'unclear' : classifyConfirmation(text);
  // "Yeah, <recognized FAQ question>" must not be consumed as consent to
  // transfer. Keep plain affirmatives and negative replies on the existing path.
  const transferConfirmation = confirmation === 'yes' && ['services', 'ai_automation'].includes(faq?.id)
    ? 'unclear' : confirmation;
  const clearFaqContext = () => {
    state.lastFaqId = null;
    state.lastFaqAt = null;
  };

  if (state.awaitingAutomationConfirmation) {
    const confirmation = transferConfirmation;
    if (confirmation === 'yes') {
      state.awaitingAutomationConfirmation = false;
      if (!transferAvailable) return { action: 'answer', answer: FAQ_RESPONSES.unavailable, faqId: 'transfer_unavailable' };
      state.stage = 'transferring';
      return { action: 'transfer', answer: 'சரி! ஒரு நிமிஷம் வெயிட் பண்ணுங்க. உங்களை எங்க டீம் கூட கனெக்ட் பண்றேன்.', faqId: 'ai_automation' };
    }
    if (confirmation === 'no') {
      state.awaitingAutomationConfirmation = false;
      return { action: 'answer', answer: 'சரி, பரவாயில்லை. வேற ஏதாவது ஹெல்ப் வேணுமா?', faqId: 'declined_automation_transfer' };
    }
    // A new question is not consent. Keep the offer pending only for a
    // standalone ambiguous reply; recognized questions continue normally.
    if (!faq && isStandaloneConfirmation(text)) {
      return { action: 'answer', answer: FAQ_RESPONSES.clarifyTransfer, faqId: 'transfer_confirmation_unclear' };
    }
    state.awaitingAutomationConfirmation = false;
  }

  if (state.awaitingHumanConfirmation) {
    const confirmation = transferConfirmation;
    if (confirmation === 'yes') {
      if (!transferAvailable) {
        state.awaitingHumanConfirmation = false;
        return { action: 'answer', answer: FAQ_RESPONSES.unavailable, faqId: 'transfer_unavailable' };
      }
      state.stage = 'transferring';
      return { action: 'transfer', answer: FAQ_ENTRIES.find(({ id }) => id === 'human_representative').answer, faqId: 'human_representative' };
    }
    if (confirmation === 'no') {
      state.awaitingHumanConfirmation = false;
      return { action: 'answer', answer: FAQ_RESPONSES.noTransfer, faqId: 'declined_transfer' };
    }
    // A new question takes precedence over an ambiguous yes/no reply.
    if (!faq && classification === 'unrelated') {
      clearFaqContext();
      return { action: 'answer', answer: FAQ_RESPONSES.unrelatedRedirect, faqId: 'unrelated_redirect' };
    }
    if (!faq && classification === 'company_unanswered') {
      clearFaqContext();
      return { action: 'answer', answer: FAQ_RESPONSES.unknown, faqId: 'unknown' };
    }
    if (!faq) return { action: 'answer', answer: FAQ_RESPONSES.clarifyTransfer, faqId: 'transfer_confirmation_unclear' };
    state.awaitingHumanConfirmation = false;
  }

  if (!faq) {
    if (classification === 'unrelated') {
      clearFaqContext();
      return { action: 'answer', answer: FAQ_RESPONSES.unrelatedRedirect, faqId: 'unrelated_redirect' };
    }
    if (classification === 'unclear') {
      return { action: 'answer', answer: FAQ_RESPONSES.clarifyQuestion, faqId: 'unclear' };
    }
    if (classification === 'company_unanswered') clearFaqContext();
    state.awaitingHumanConfirmation = true;
    return { action: 'answer', answer: FAQ_RESPONSES.unknown, faqId: 'unknown' };
  }
  if (faq.endCall) {
    state.stage = 'ending';
    return { action: 'end', answer: faq.answer, faqId: faq.id };
  }
  if (faq.id === 'human_representative') {
    if (!transferAvailable) return { action: 'answer', answer: FAQ_RESPONSES.unavailable, faqId: 'transfer_unavailable' };
    state.stage = 'transferring';
    return { action: 'transfer', answer: faq.answer, faqId: faq.id };
  }
  if (faq.id === 'ai_automation') state.awaitingAutomationConfirmation = true;
  if (faq.id === 'offers' || faq.id === 'unknown') state.awaitingHumanConfirmation = true;
  if (faq.id !== 'human_representative') {
    state.lastFaqId = faq.id;
    state.lastFaqAt = Date.now();
  }
  return { action: 'answer', answer: faq.answer, faqId: faq.id, contextResolution };
};

// Shared by the authenticated live WebSocket handler and the route-level tests.
export const processLiveConversationRelayFaqTurn = (state, prompt, {
  transferAvailable, send, matcher, strictConfirmation, contextEnabled, classification
}) => {
  const baseResult = processFaqPrompt(state, prompt, {
    transferAvailable, matcher, strictConfirmation, contextEnabled, classification
  });
  const matchedIntent = FAQ_ENTRIES.find(({ id }) => id === baseResult.faqId)?.intent
    || String(baseResult.faqId || 'unknown').toUpperCase();
  const result = { ...baseResult, matchedIntent };
  if (result.action === 'answer') {
    const sent = send({ type: 'text', token: result.answer, lang: 'ta-IN', last: true, interruptible: true, preemptible: false });
    return { ...result, responseStatus: sent ? 'spoken' : 'send_failed' };
  }
  if (result.action === 'transfer') {
    let confirmationSent = true;
    if (result.faqId === 'ai_automation') {
      confirmationSent = send({ type: 'text', token: result.answer, lang: 'ta-IN', last: true, interruptible: true, preemptible: false });
    }
    const handoffSent = send({
      type: 'end',
      handoffData: JSON.stringify({ status: 'faq_transfer', faqId: result.faqId || null })
    });
    return { ...result, confirmationSent, handoffSent, responseStatus: 'transfer_requested' };
  }
  if (result.action === 'end') {
    const sent = send({ type: 'end', handoffData: JSON.stringify({ status: 'faq_goodbye' }) });
    return { ...result, responseStatus: sent ? 'end_requested' : 'send_failed' };
  }
  return { ...result, responseStatus: 'no_response' };
};

export const buildFaqHandoffActions = (handoff, data = {}) => {
  if (handoff?.status === 'faq_goodbye') {
    return [{ type: 'say', text: FAQ_RESPONSES.goodbye }, { type: 'hangup' }];
  }
  if (handoff?.status !== 'faq_transfer') return null;
  if (handoff.faqId === 'ai_automation') {
    const destination = String(data.humanAgentPhoneNumber || '').trim();
    if (data.transferOnCustomerRequest === false || !/^\+[1-9]\d{7,14}$/.test(destination)) {
      return [{ type: 'say', text: FAQ_RESPONSES.unavailable }, { type: 'hangup' }];
    }
    return [{ type: 'dial', destination }];
  }
  const destination = String(data.humanAgentPhoneNumber || '').trim();
  if (data.transferOnCustomerRequest === false || !/^\+[1-9]\d{7,14}$/.test(destination)) {
    return [{ type: 'say', text: FAQ_RESPONSES.unavailable }, { type: 'hangup' }];
  }
  return [
    { type: 'say', text: FAQ_ENTRIES.find(({ id }) => id === 'human_representative').answer },
    { type: 'dial', destination }
  ];
};
