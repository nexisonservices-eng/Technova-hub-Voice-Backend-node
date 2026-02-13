// API Configuration for Nexion Voice Automation Platform
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:5000';
const WS_BASE_URL = process.env.REACT_APP_WS_BASE_URL || 'http://localhost:5000';

export const API_ENDPOINTS = {
  // Authentication
  AUTH: {
    LOGIN: `${API_BASE_URL}/api/auth/login`,
    LOGOUT: `${API_BASE_URL}/api/auth/logout`,
    REFRESH: `${API_BASE_URL}/api/auth/refresh`,
  },

  // Outbound Campaign Management
  CAMPAIGNS: {
    LIST: `${API_BASE_URL}/api/campaigns`,
    CREATE: `${API_BASE_URL}/api/campaigns`,
    GET: (id) => `${API_BASE_URL}/api/campaigns/${id}`,
    UPDATE: (id) => `${API_BASE_URL}/api/campaigns/${id}`,
    DELETE: (id) => `${API_BASE_URL}/api/campaigns/${id}`,
    START: (id) => `${API_BASE_URL}/api/campaigns/${id}/start`,
    PAUSE: (id) => `${API_BASE_URL}/api/campaigns/${id}/pause`,
    RESUME: (id) => `${API_BASE_URL}/api/campaigns/${id}/resume`,
    STOP: (id) => `${API_BASE_URL}/api/campaigns/${id}/stop`,
    STATISTICS: (id) => `${API_BASE_URL}/api/campaigns/${id}/statistics`,
    UPLOAD_CONTACTS: (id) => `${API_BASE_URL}/api/campaigns/${id}/contacts/upload`,
    VALIDATE_CONTACTS: (id) => `${API_BASE_URL}/api/campaigns/${id}/contacts/validate`,
  },

  // Inbound Call Management
  INBOUND: {
    CALLS: `${API_BASE_URL}/api/inbound/calls`,
    ACTIVE_CALLS: `${API_BASE_URL}/api/inbound/calls/active`,
    CALL_DETAILS: (id) => `${API_BASE_URL}/api/inbound/calls/${id}`,
    QUEUE: `${API_BASE_URL}/api/inbound/queue`,
    TRANSFER: (id) => `${API_BASE_URL}/api/inbound/calls/${id}/transfer`,
    HANGUP: (id) => `${API_BASE_URL}/api/inbound/calls/${id}/hangup`,
  },

  // IVR Configuration
  IVR: {
    MENUS: `${API_BASE_URL}/api/ivr/menus`,
    CREATE_MENU: `${API_BASE_URL}/api/ivr/menus`,
    GET_MENU: (id) => `${API_BASE_URL}/api/ivr/menus/${id}`,
    UPDATE_MENU: (id) => `${API_BASE_URL}/api/ivr/menus/${id}`,
    DELETE_MENU: (id) => `${API_BASE_URL}/api/ivr/menus/${id}`,
    TEST_MENU: (id) => `${API_BASE_URL}/api/ivr/menus/${id}/test`,
  },

  // Routing Rules
  ROUTING: {
    RULES: `${API_BASE_URL}/api/routing/rules`,
    CREATE_RULE: `${API_BASE_URL}/api/routing/rules`,
    GET_RULE: (id) => `${API_BASE_URL}/api/routing/rules/${id}`,
    UPDATE_RULE: (id) => `${API_BASE_URL}/api/routing/rules/${id}`,
    DELETE_RULE: (id) => `${API_BASE_URL}/api/routing/rules/${id}`,
    REORDER: `${API_BASE_URL}/api/routing/rules/reorder`,
  },

  // Callback Management
  CALLBACKS: {
    LIST: `${API_BASE_URL}/api/callbacks`,
    CREATE: `${API_BASE_URL}/api/callbacks`,
    UPDATE: (id) => `${API_BASE_URL}/api/callbacks/${id}`,
    DELETE: (id) => `${API_BASE_URL}/api/callbacks/${id}`,
    COMPLETE: (id) => `${API_BASE_URL}/api/callbacks/${id}/complete`,
  },

  // Voicemail
  VOICEMAIL: {
    LIST: `${API_BASE_URL}/api/voicemail`,
    GET: (id) => `${API_BASE_URL}/api/voicemail/${id}`,
    MARK_READ: (id) => `${API_BASE_URL}/api/voicemail/${id}/read`,
    DELETE: (id) => `${API_BASE_URL}/api/voicemail/${id}`,
    TRANSCRIPTION: (id) => `${API_BASE_URL}/api/voicemail/${id}/transcription`,
  },

  // Analytics
  ANALYTICS: {
    DASHBOARD: `${API_BASE_URL}/api/analytics/dashboard`,
    CAMPAIGN_REPORT: (id) => `${API_BASE_URL}/api/analytics/campaigns/${id}`,
    INBOUND_REPORT: `${API_BASE_URL}/api/analytics/inbound`,
    EXPORT: `${API_BASE_URL}/api/analytics/export`,
  },

  // Voice Settings
  VOICE: {
    LIST_VOICES: `${API_BASE_URL}/api/voice/list`,
    TEST_VOICE: `${API_BASE_URL}/api/voice/test`,
  },
};

export const SOCKET_EVENTS = {
  // Connection
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  ERROR: 'error',

  // Outbound Campaign Events
  CAMPAIGN_STARTED: 'campaign:started',
  CAMPAIGN_PAUSED: 'campaign:paused',
  CAMPAIGN_RESUMED: 'campaign:resumed',
  CAMPAIGN_STOPPED: 'campaign:stopped',
  CAMPAIGN_COMPLETED: 'campaign:completed',
  CAMPAIGN_STATS_UPDATE: 'campaign:stats:update',
  CALL_STATUS_UPDATE: 'call:status:update',
  CALL_INITIATED: 'call:initiated',
  CALL_CONNECTED: 'call:connected',
  CALL_COMPLETED: 'call:completed',
  CALL_FAILED: 'call:failed',

  // Inbound Call Events
  INBOUND_CALL_RECEIVED: 'inbound:call:received',
  INBOUND_CALL_ANSWERED: 'inbound:call:answered',
  INBOUND_CALL_ENDED: 'inbound:call:ended',
  QUEUE_UPDATE: 'queue:update',
  QUEUE_CALLER_ADDED: 'queue:caller:added',
  QUEUE_CALLER_REMOVED: 'queue:caller:removed',
  QUEUE_POSITION_UPDATE: 'queue:position:update',

  // Agent Events
  AGENT_STATUS_CHANGE: 'agent:status:change',

  // Callback Events
  CALLBACK_SCHEDULED: 'callback:scheduled',
  CALLBACK_DUE: 'callback:due',

  // Voicemail Events
  VOICEMAIL_RECEIVED: 'voicemail:received',
  VOICEMAIL_TRANSCRIBED: 'voicemail:transcribed',
};

// Enhanced SOCKET_EVENTS for IVR Workflows
export const IVR_WORKFLOW_EVENTS = {
  // Workflow Configuration
  WORKFLOW_CREATED: 'workflow:created',
  WORKFLOW_UPDATED: 'workflow:updated',
  WORKFLOW_DELETED: 'workflow:deleted',
  WORKFLOW_TESTED: 'workflow:tested',

  // Real-time Collaboration
  WORKFLOW_EDIT_START: 'workflow:edit:start',
  WORKFLOW_EDIT_END: 'workflow:edit:end',
  WORKFLOW_NODE_ADDED: 'workflow:node:added',
  WORKFLOW_NODE_MOVED: 'workflow:node:moved',
  WORKFLOW_NODE_DELETED: 'workflow:node:deleted',
  WORKFLOW_EDGE_CONNECTED: 'workflow:edge:connected',

  // Live Call Monitoring
  WORKFLOW_CALL_STARTED: 'workflow:call:started',
  WORKFLOW_CALL_NODE: 'workflow:call:node',
  WORKFLOW_CALL_COMPLETED: 'workflow:call:completed',
  WORKFLOW_CALL_ERROR: 'workflow:call:error',

  // Industry-Specific Events
  HOTEL_BOOKING_REQUEST: 'industry:hotel:booking',
  INSURANCE_CLAIM_FILED: 'industry:insurance:claim',
  HEALTHCARE_APPOINTMENT: 'industry:healthcare:appointment',

  // Analytics & Monitoring
  WORKFLOW_STATS_UPDATE: 'workflow:stats:update',
  WORKFLOW_PERFORMANCE: 'workflow:performance',
  WORKFLOW_ERROR_RATE: 'workflow:error_rate'
};

export const WS_CONFIG = {
  url: WS_BASE_URL,
  options: {
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    transports: ['websocket', 'polling'],
  },
};

export const VOICE_OPTIONS = {
  TAMIL: [
    { value: 'ta-IN-PallaviNeural', label: 'Pallavi (Female)', language: 'Tamil', gender: 'Female' },
    { value: 'ta-IN-ValluvarNeural', label: 'Valluvar (Male)', language: 'Tamil', gender: 'Male' },
  ],
  BRITISH_ENGLISH: [
    { value: 'en-GB-SoniaNeural', label: 'Sonia (Female)', language: 'British English', gender: 'Female' },
    { value: 'en-GB-RyanNeural', label: 'Ryan (Male)', language: 'British English', gender: 'Male' },
    { value: 'en-GB-LibbyNeural', label: 'Libby (Female)', language: 'British English', gender: 'Female' },
    { value: 'en-GB-ThomasNeural', label: 'Thomas (Male)', language: 'British English', gender: 'Male' },
  ],
};

export const CALL_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  INITIATED: 'initiated',
  RINGING: 'ringing',
  IN_PROGRESS: 'in-progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  NO_ANSWER: 'no-answer',
  BUSY: 'busy',
  VOICEMAIL: 'voicemail',
};

export const CAMPAIGN_STATUS = {
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
};

export const ROUTING_TYPES = {
  VIP: 'vip',
  DEPARTMENT: 'department',
  TIME_BASED: 'time-based',
  SKILL_BASED: 'skill-based',
  ROUND_ROBIN: 'round-robin',
};

export default {
  API_ENDPOINTS,
  SOCKET_EVENTS,
  WS_CONFIG,
  VOICE_OPTIONS,
  CALL_STATUS,
  CAMPAIGN_STATUS,
  ROUTING_TYPES,
  IVR_WORKFLOW_EVENTS,
};