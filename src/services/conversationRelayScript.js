export const SCRIPT_SECTIONS = Object.freeze([
  {
    stage: 'welcome',
    text: 'Hello! Welcome to TechnovaHub. We provide IT Services, AI Automation, and Digital Transformation Solutions to help businesses work smarter and grow faster.'
  },
  {
    stage: 'nexion_introduction',
    text: 'Let me introduce Nexion, a business automation solution developed by TechnovaHub. Nexion helps businesses automate repetitive tasks, simplify workflows, reduce manual work, and improve operational efficiency.'
  },
  {
    stage: 'benefits',
    text: 'With Nexion, your business can save valuable time, connect important tools and processes, monitor performance, and focus more on business growth.'
  },
  {
    stage: 'offer_question',
    text: 'Would you like to know about our special offers or speak with our team for more details?'
  }
]);

export const SCRIPT_MESSAGES = Object.freeze(SCRIPT_SECTIONS.map((section, index) => ({
  type: 'text',
  token: section.text,
  last: index === SCRIPT_SECTIONS.length - 1,
  interruptible: false,
  preemptible: false
})));

export const SCRIPT_RESPONSES = Object.freeze({
  transfer: 'Thank you for your interest! Please hold while I connect you with our team.',
  decline: 'Thank you for your time. Have a wonderful day!',
  unclear: "Sorry, I didn't catch that. Would you like to speak with our team? Please say yes or no.",
  unavailable: 'Sorry, connecting you with our team is unavailable right now. Thank you for your time. Have a wonderful day!'
});

const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'okay', 'ok', 'sure', 'interested', 'venum']);
const NO_WORDS = new Set(['no', 'nope', 'illa', 'vendam']);

export const classifyScriptReply = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'unclear';

  if (/\bnot\s+interested\b/.test(text)) return 'no';
  const words = text.match(/[a-z]+/g) || [];
  const hasYes = words.some((word) => YES_WORDS.has(word)) || /ஆமாம்|சரி/.test(text);
  const hasNo = words.some((word) => NO_WORDS.has(word)) || /வேண்டாம்/.test(text);
  if (hasYes === hasNo) return 'unclear';
  return hasYes ? 'yes' : 'no';
};

export const createScriptState = () => ({ stage: 'welcome', turns: 0 });

export const startScript = (state) => {
  if (state.stage !== 'welcome') return { status: 'ignored', messages: [] };
  state.stage = 'awaiting_answer';
  return { status: 'started', messages: SCRIPT_MESSAGES };
};

export const handleScriptReply = (state, reply, { transferAvailable }) => {
  if (state.stage !== 'awaiting_answer') return { status: 'ignored' };
  state.turns += 1;
  const classification = classifyScriptReply(reply);

  if (classification === 'unclear') {
    return { status: 'clarify', classification, token: SCRIPT_RESPONSES.unclear };
  }
  if (classification === 'no') {
    state.stage = 'ending';
    return { status: 'end', classification, handoff: { status: 'script_decline' } };
  }
  if (!transferAvailable) {
    state.stage = 'ending';
    return { status: 'end', classification, handoff: { status: 'script_unavailable' } };
  }
  state.stage = 'transferring';
  return {
    status: 'transfer', classification,
    handoff: { status: 'transfer', intent: 'human_transfer', scriptVoiceAgent: true }
  };
};

export const buildScriptHandoffActions = (handoff, data = {}) => {
  if (handoff?.status === 'script_decline') {
    return [{ type: 'say', text: SCRIPT_RESPONSES.decline }, { type: 'hangup' }];
  }
  if (handoff?.status === 'script_unavailable') {
    return [{ type: 'say', text: SCRIPT_RESPONSES.unavailable }, { type: 'hangup' }];
  }
  if (handoff?.status !== 'transfer' || handoff.scriptVoiceAgent !== true) return null;

  const destination = String(data.humanAgentPhoneNumber || '').trim();
  const transferAvailable = data.transferOnCustomerRequest !== false
    && /^\+[1-9]\d{7,14}$/.test(destination);
  if (!transferAvailable) {
    return [{ type: 'say', text: SCRIPT_RESPONSES.unavailable }, { type: 'hangup' }];
  }
  return [
    { type: 'say', text: SCRIPT_RESPONSES.transfer },
    { type: 'dial', destination }
  ];
};
