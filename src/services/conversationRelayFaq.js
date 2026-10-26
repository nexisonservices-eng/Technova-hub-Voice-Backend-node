export const FAQ_WELCOME = 'வணக்கம்! TechnovaHub-க்கு உங்களை வரவேற்கிறோம். நான் உங்களோட AI ஹெல்ப்பர். உங்களுக்கு எப்படி ஹெல்ப் பண்ணலாம்?';

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
    id: 'ai_automation',
    answer: 'எங்களோட AI ஆட்டோமேஷன் சர்வீசஸ் பத்தியும், அதுக்கான ஸ்பெஷல் ஆஃபர்ஸ் பத்தியும் எங்க டீம் கிட்ட டீடெயிலா தெரிஞ்சிக்கலாம். உங்களை எங்க டீம் கூட கனெக்ட் பண்ணட்டுமா?',
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
    answer: 'நம்ம TechnovaHub-ல IT சர்வீசஸ், AI ஆட்டோமேஷன், டிஜிட்டல் டிரான்ஸ்ஃபர்மேஷன் சர்வீசஸ் எல்லாம் பண்ணிட்டு இருக்கோம். பிசினஸ்க்கு தேவையான டெக்னாலஜி சொல்யூஷன்ஸ் கொடுக்குறோம்.',
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

const normalizeQuestion = (value) => {
  let text = normalize(value);
  for (const tamilName of TAMIL_NEXION_NAMES) text = text.replaceAll(tamilName, 'nexion');
  return text;
};

const containsAny = (text, phrases) => phrases.some((phrase) => text.includes(normalize(phrase)));
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

export const matchFaq = (value) => {
  const text = normalizeQuestion(value);
  if (!text) return null;
  if (containsAny(text, ['goodbye', 'bye bye', 'bye', 'hang up', 'end the call', 'நான் போகிறேன்', 'போயிட்டு வரேன்'])) {
    return { id: 'goodbye', answer: FAQ_RESPONSES.goodbye, endCall: true };
  }
  if (containsAny(text, ['thank you', 'thanks', 'நன்றி', 'nandri', 'romba thanks']) && text.split(' ').length <= 5) {
    return FAQ_ENTRIES.find(({ id }) => id === 'thanks');
  }

  // Specific intents come first so broad phrases such as "Nexion" cannot
  // swallow benefit, automation, or contact questions.
  const priority = ['human_representative', 'ai_automation', 'offers', 'repetitive_tasks', 'nexion_benefits', 'businesses', 'contact', 'services', 'nexion', 'technovahub'];
  for (const id of priority) {
    const entry = FAQ_ENTRIES.find((candidate) => candidate.id === id);
    if (containsAny(text, entry.patterns)) return entry;
  }
  return null;
};

export const createFaqState = (callSid = '') => ({
  callSid: String(callSid || ''),
  stage: 'awaiting_question',
  awaitingHumanConfirmation: false,
  awaitingAutomationConfirmation: false,
  turns: 0
});

export const processFaqPrompt = (state, prompt, { transferAvailable }) => {
  if (state.stage !== 'awaiting_question') return { action: 'ignored' };
  const text = String(prompt || '').trim().slice(0, 3000);
  state.turns += 1;

  if (state.awaitingAutomationConfirmation) {
    const confirmation = classifyConfirmation(text);
    if (confirmation === 'yes') {
      state.awaitingAutomationConfirmation = false;
      if (!transferAvailable) return { action: 'answer', answer: FAQ_RESPONSES.unavailable, faqId: 'transfer_unavailable' };
      state.stage = 'transferring';
      return { action: 'transfer', answer: 'சரி! ஒரு நிமிஷம் வெயிட் பண்ணுங்க. உங்களை எங்க டீம் கூட கனெக்ட் பண்றேன்.', faqId: 'ai_automation' };
    }
    if (confirmation === 'no') {
      state.awaitingAutomationConfirmation = false;
      return { action: 'answer', answer: 'சரி, பரவாயில்லை. வேற ஏதாவது தெரிஞ்சிக்கணுமா?', faqId: 'declined_automation_transfer' };
    }
    state.awaitingAutomationConfirmation = false;
  }

  if (state.awaitingHumanConfirmation) {
    const confirmation = classifyConfirmation(text);
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
    const followup = matchFaq(text);
    if (!followup) return { action: 'answer', answer: FAQ_RESPONSES.clarifyTransfer, faqId: 'transfer_confirmation_unclear' };
    state.awaitingHumanConfirmation = false;
  }

  const faq = matchFaq(text);
  if (!faq) {
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
  return { action: 'answer', answer: faq.answer, faqId: faq.id };
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
