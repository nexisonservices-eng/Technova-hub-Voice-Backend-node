export const FAQ_WELCOME = "Hello! Welcome to TechnovaHub. I'm your virtual assistant. How may I help you today?";

export const FAQ_ENTRIES = Object.freeze([
  {
    id: 'technovahub',
    answer: 'TechnovaHub is a technology company that helps businesses improve their operations through IT services, intelligent automation, and digital transformation.',
    patterns: ['what is technovahub', 'whats technovahub', 'tell me about technovahub', 'explain technovahub', 'technovahub na enna', 'technovahub என்றால் என்ன', 'technovahub என்ன', 'technovahub pathi']
  },
  {
    id: 'services',
    answer: 'TechnovaHub provides IT Services and Consulting, AI Automation, and Digital Transformation Solutions.',
    patterns: ['what services', 'which services', 'services do you provide', 'services do you offer', 'what do you provide', 'what do you offer', 'what do you do', 'என்னென்ன சேவைகள்', 'என்ன சேவைகள்', 'enna services', 'enna service', 'services enna', 'services provide', 'services offer']
  },
  {
    id: 'nexion',
    answer: 'Nexion is a business automation solution developed by TechnovaHub. It helps businesses simplify workflows, automate repetitive tasks, and reduce manual work.',
    patterns: ['what is nexion', 'whats nexion', 'tell me about nexion', 'explain nexion', 'what does nexion do', 'nexion na enna', 'nexion enna', 'nexion என்றால் என்ன', 'nexion என்ன', 'nexion pathi']
  },
  {
    id: 'repetitive_tasks',
    answer: 'Yes. Nexion is designed to help businesses automate repetitive tasks and simplify everyday workflows.',
    patterns: ['automate repetitive tasks', 'automate repeated tasks', 'automate tasks', 'repetitive tasks automate', 'can nexion automate', 'repeat tasks automate', 'திரும்பத் திரும்ப செய்யும் பணிகள்', 'repetitive work automate']
  },
  {
    id: 'nexion_benefits',
    answer: 'Nexion helps businesses save time, improve efficiency, connect important tools and processes, and focus on business growth.',
    patterns: ['how does nexion help', 'how can nexion help', 'what are the benefits', 'nexion benefits', 'benefits of nexion', 'how nexion works', 'nexion use enna', 'nexion epdi help', 'nexion eppadi help', 'nexion epdi work', 'nexion எப்படி உதவும்', 'nexion நன்மைகள்']
  },
  {
    id: 'businesses',
    answer: 'Our solutions are designed for businesses across industries, including startups, retail, manufacturing, financial services, and small and medium enterprises.',
    patterns: ['which businesses', 'what businesses', 'who can use', 'which industries', 'what industries', 'industries can use', 'who are these solutions for', 'small businesses use', 'எந்த நிறுவனங்கள்', 'யார் பயன்படுத்தலாம்', 'entha business', 'yaar use pannalaam', 'businesses use pannalaam']
  },
  {
    id: 'offers',
    answer: 'Our team can provide information about currently available offers. Would you like me to connect you with a representative?',
    patterns: ['discount', 'special offer', 'special offers', 'any offers', 'current offers', 'promotion', 'rebate', 'சலுகை', 'offer iruka', 'discount iruka', 'offer irukkaa', 'offers irukka']
  },
  {
    id: 'human_representative',
    answer: 'Certainly! Please hold while I connect you with our team.',
    patterns: ['speak to a human', 'speak with a human', 'human representative', 'talk to a person', 'speak to a person', 'talk to someone', 'connect me to a human', 'representative', 'live agent', 'human support', 'team kitta pesanum', 'oru person kitta', 'மனிதரிடம் பேச', 'பிரதிநிதியிடம் பேச']
  },
  {
    id: 'contact',
    answer: 'You can contact TechnovaHub at plus nine one, nine zero zero three five, three zero two three zero, or visit www.technovahub.in.',
    patterns: ['contact technovahub', 'contact number', 'phone number', 'how can i contact', 'how to contact', 'website', 'web site', 'contact details', 'எப்படி தொடர்பு', 'contact epdi', 'phone number enna']
  },
  {
    id: 'thanks',
    answer: "You're welcome! Is there anything else I can help you with?",
    patterns: ['thank you', 'thanks', 'நன்றி', 'nandri', 'romba thanks']
  }
]);

export const FAQ_RESPONSES = Object.freeze({
  unknown: "I'm sorry, I don't have that information right now. Would you like me to connect you with our team?",
  noTransfer: "No problem. What else can I help you with?",
  clarifyTransfer: 'Please say yes or no, or ask me another question.',
  unavailable: 'Sorry, connecting you with our team is unavailable right now. What else can I help you with?',
  goodbye: 'Thank you for contacting TechnovaHub. Have a wonderful day!'
});

const normalize = (value) => String(value || '')
  .toLowerCase()
  .replace(/[’']/g, '')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

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
  const text = normalize(value);
  if (!text) return null;
  if (containsAny(text, ['goodbye', 'bye bye', 'bye', 'hang up', 'end the call', 'நான் போகிறேன்', 'போயிட்டு வரேன்'])) {
    return { id: 'goodbye', answer: FAQ_RESPONSES.goodbye, endCall: true };
  }
  if (containsAny(text, ['thank you', 'thanks', 'நன்றி', 'nandri', 'romba thanks']) && text.split(' ').length <= 5) {
    return FAQ_ENTRIES.find(({ id }) => id === 'thanks');
  }

  // Specific intents come first so broad phrases such as "Nexion" cannot
  // swallow benefit, automation, or contact questions.
  const priority = ['human_representative', 'offers', 'repetitive_tasks', 'nexion_benefits', 'businesses', 'contact', 'services', 'nexion', 'technovahub'];
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
  turns: 0
});

export const processFaqPrompt = (state, prompt, { transferAvailable }) => {
  if (state.stage !== 'awaiting_question') return { action: 'ignored' };
  const text = String(prompt || '').trim().slice(0, 3000);
  state.turns += 1;

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
  if (faq.id === 'offers' || faq.id === 'unknown') state.awaitingHumanConfirmation = true;
  return { action: 'answer', answer: faq.answer, faqId: faq.id };
};

export const buildFaqHandoffActions = (handoff, data = {}) => {
  if (handoff?.status === 'faq_goodbye') {
    return [{ type: 'say', text: FAQ_RESPONSES.goodbye }, { type: 'hangup' }];
  }
  if (handoff?.status !== 'faq_transfer') return null;
  const destination = String(data.humanAgentPhoneNumber || '').trim();
  if (data.transferOnCustomerRequest === false || !/^\+[1-9]\d{7,14}$/.test(destination)) {
    return [{ type: 'say', text: FAQ_RESPONSES.unavailable }, { type: 'hangup' }];
  }
  return [
    { type: 'say', text: FAQ_ENTRIES.find(({ id }) => id === 'human_representative').answer },
    { type: 'dial', destination }
  ];
};
