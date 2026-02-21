/**
 * Clean Workflow Node Configuration
 * Removes duplicate logic and consolidates node configurations
 */

// Node Types
export const NODE_TYPES = {
  GREETING: 'greeting',
  AUDIO: 'audio',  // Added for frontend compatibility
  MENU: 'menu',
  USER_INPUT: 'input',
  SPEECH_INPUT: 'speech_input',
  CONDITIONAL: 'conditional',
  VOICEMAIL: 'voicemail',
  TRANSFER: 'transfer',
  REPEAT: 'repeat',
  END: 'end',
  AI_ASSISTANT: 'ai_assistant',
  QUEUE: 'queue',
  SMS: 'sms',
  SET_VARIABLE: 'set_variable',
  API_CALL: 'api_call'
};

// Node Categories
export const NODE_CATEGORIES = {
  INTERACTION: 'interaction',
  LOGIC: 'logic',
  ACTION: 'action',
  SERVICE: 'service',
  DATA: 'data'
};

// Node Configurations - Consolidated and deduplicated
export const NODE_CONFIGS = {
  [NODE_TYPES.GREETING]: {
    name: 'Greeting/Menu',
    category: NODE_CATEGORIES.INTERACTION,
    icon: '👋',
    description: 'Welcome message and menu options',
    color: '#4CAF50',
    inputs: 1,
    outputs: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#', 'timeout', 'no_match'],
    dataSchema: {
      text: { type: 'string', required: true, label: 'Welcome Message' },
      voice: { type: 'select', options: ['alice', 'man', 'woman', 'man', 'woman2'], default: 'alice', label: 'Voice' },
      language: { type: 'string', default: 'en-US', label: 'Language' },
      audioUrl: { type: 'url', label: 'Audio File URL' },
      menuOptions: { type: 'array', label: 'Menu Options', itemSchema: { digit: { type: 'string' }, text: { type: 'string' } } },
      timeout: { type: 'number', default: 10, min: 1, max: 60, label: 'Timeout (seconds)' },
      maxRetries: { type: 'number', default: 3, min: 1, max: 10, label: 'Max Retries' }
    },
    validation: {
      required: ['text'],
      rules: {
        text: { minLength: 1, maxLength: 500 }
      }
    }
  },

  // AUDIO type - Frontend-compatible version of GREETING
  [NODE_TYPES.AUDIO]: {
    name: 'Audio Message',
    category: NODE_CATEGORIES.INTERACTION,
    icon: '🔊',
    description: 'Play audio message (TTS or uploaded file)',
    color: '#4CAF50',
    inputs: 1,
    outputs: ['next', 'timeout'],
    dataSchema: {
      // Frontend field names (mapped in IVRMenuCard.jsx)
      mode: { type: 'select', options: ['tts', 'upload'], default: 'tts', label: 'Audio Mode' },
      messageText: { type: 'string', required: true, label: 'Message Text (for TTS)', condition: { mode: 'tts' } },
      voice: { type: 'string', default: 'en-GB-SoniaNeural', label: 'Voice' },
      language: { type: 'string', default: 'en-GB', label: 'Language' },
      audioUrl: { type: 'url', label: 'Audio File URL', condition: { mode: 'upload' } },
      audioAssetId: { type: 'string', label: 'Audio Asset ID' },
      afterPlayback: { type: 'select', options: ['next', 'wait'], default: 'next', label: 'After Playback' },
      timeoutSeconds: { type: 'number', default: 10, min: 1, max: 60, label: 'Timeout (seconds)' },
      maxRetries: { type: 'number', default: 3, min: 1, max: 10, label: 'Max Retries' },
      fallbackAudioNodeId: { type: 'string', label: 'Fallback Audio Node' },
      // Backend-mapped field names (for compatibility)
      text: { type: 'string', label: 'Text (mapped from messageText)' },
      timeout: { type: 'number', default: 10, min: 1, max: 60, label: 'Timeout' },
      max_retries: { type: 'number', default: 3, min: 1, max: 10, label: 'Max Retries' }
    },
    validation: {
      required: ['mode'],
      rules: {
        messageText: { minLength: 1, maxLength: 500, condition: { mode: 'tts' } },
        audioUrl: { required: true, condition: { mode: 'upload' } }
      }
    }
  },

  [NODE_TYPES.USER_INPUT]: {
    name: 'User Input',
    category: NODE_CATEGORIES.INTERACTION,
    icon: '⌨️',
    description: 'Collect user input via DTMF or speech',
    color: '#2196F3',
    inputs: 1,
    outputs: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#', 'timeout', 'no_match'],
    dataSchema: {
      digit: { type: 'string', default: '1', label: 'Digit' },
      label: { type: 'string', default: '', label: 'Label' },
      action: { type: 'select', options: ['transfer', 'voicemail', 'menu', 'end'], default: 'transfer', label: 'Action' },
      destination: { type: 'string', label: 'Destination', placeholder: '+1234567890' },
      promptAudioNodeId: { type: 'string', label: 'Prompt Audio Node ID' },
      invalidAudioNodeId: { type: 'string', label: 'Invalid Audio Node ID' },
      timeoutAudioNodeId: { type: 'string', label: 'Timeout Audio Node ID' },
      maxAttempts: { type: 'number', default: 3, min: 1, max: 10, label: 'Max Attempts' },
      timeoutSeconds: { type: 'number', default: 10, min: 1, max: 60, label: 'Timeout (seconds)' },
      // Backend-mapped fields
      timeout: { type: 'number', default: 10, min: 1, max: 60, label: 'Timeout' },
      max_attempts: { type: 'number', default: 3, min: 1, max: 10, label: 'Max Attempts' }
    },
    validation: {
      required: ['digit', 'action'],
      rules: {
        destination: { pattern: /^\+?[1-9]\d{1,14}$/, condition: { action: 'transfer' } },
        timeout: { min: 1, max: 60 },
        maxAttempts: { min: 1, max: 10 }
      }
    }
  },

  [NODE_TYPES.CONDITIONAL]: {
    name: 'Conditional',
    category: NODE_CATEGORIES.LOGIC,
    icon: '🔀',
    description: 'Route calls based on conditions',
    color: '#FF9800',
    inputs: 1,
    outputs: ['true', 'false'],
    dataSchema: {
      condition: { type: 'select', options: ['business_hours', 'caller_id', 'custom'], default: 'business_hours', label: 'Condition Type' },
      variable: { type: 'string', label: 'Variable Name' },
      operator: { type: 'select', options: ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'exists', 'regex'], default: 'equals', label: 'Operator' },
      value: { type: 'string', label: 'Value' },
      truePath: { type: 'string', label: 'True Path Node ID' },
      falsePath: { type: 'string', label: 'False Path Node ID' },
      // Backend-mapped fields
      true_path: { type: 'string', label: 'True Path' },
      false_path: { type: 'string', label: 'False Path' }
    },
    validation: {
      required: ['condition'],
      rules: {
        variable: { minLength: 1, maxLength: 100, condition: { condition: 'custom' } },
        value: { maxLength: 200 }
      }
    }
  },

  [NODE_TYPES.VOICEMAIL]: {
    name: 'Voicemail',
    category: NODE_CATEGORIES.ACTION,
    icon: '📬',
    description: 'Record voicemail messages',
    color: '#9C27B0',
    inputs: 1,
    outputs: ['completed', 'timeout', 'error'],
    dataSchema: {
      text: { type: 'string', default: 'Please leave your message after the beep.', label: 'Voicemail Prompt' },
      maxLength: { type: 'number', default: 60, min: 1, max: 300, label: 'Max Length (seconds)' },
      transcribe: { type: 'boolean', default: true, label: 'Transcribe Recording' },
      playBeep: { type: 'boolean', default: true, label: 'Play Beep' },
      greetingAudioNodeId: { type: 'string', label: 'Greeting Audio Node ID' },
      mailbox: { type: 'string', default: 'general', label: 'Mailbox' },
      storageRoute: { type: 'string', label: 'Storage Route' },
      // Backend-mapped fields
      max_length: { type: 'number', default: 60, min: 1, max: 300, label: 'Max Length' },
      greeting_audio_node_id: { type: 'string', label: 'Greeting Audio Node ID' }
    },
    validation: {
      rules: {
        text: { minLength: 1, maxLength: 500 },
        maxLength: { min: 1, max: 300 }
      }
    }
  },

  [NODE_TYPES.TRANSFER]: {
    name: 'Transfer',
    category: NODE_CATEGORIES.ACTION,
    icon: '📞',
    description: 'Transfer call to another number or agent',
    color: '#F44336',
    inputs: 1,
    outputs: ['answered', 'busy', 'no_answer', 'failed'],
    dataSchema: {
      destination: { type: 'string', required: true, label: 'Destination Number', placeholder: '+1234567890' },
      label: { type: 'string', label: 'Label' },
      announceText: { type: 'string', label: 'Announcement Text', placeholder: 'Transferring you now...' },
      timeout: { type: 'number', default: 30, min: 10, max: 120, label: 'Ring Timeout (seconds)' },
      // Backend-mapped fields
      announce_text: { type: 'string', label: 'Announcement Text' }
    },
    validation: {
      required: ['destination'],
      rules: {
        destination: { pattern: /^\+?[1-9]\d{1,14}$/ },
        timeout: { min: 10, max: 120 }
      }
    }
  },

  [NODE_TYPES.REPEAT]: {
    name: 'Repeat',
    category: NODE_CATEGORIES.LOGIC,
    icon: '🔄',
    description: 'Repeat previous prompt or menu',
    color: '#9E9E9E',
    inputs: 1,
    outputs: ['repeat', 'fallback', 'max_reached'],
    dataSchema: {
      maxRepeats: { type: 'number', default: 3, min: 1, max: 10, label: 'Max Repeats' },
      repeatMessage: { type: 'string', label: 'Repeat Message', placeholder: 'Message to play before repeating...' },
      fallbackNodeId: { type: 'select', label: 'Fallback Node (When max repeats reached)', options: 'dynamic', allowCustom: true },
      fallbackMessage: { type: 'string', label: 'Fallback Message', placeholder: 'Maximum attempts reached. Transferring to agent.' },
      replayLastPrompt: { type: 'boolean', default: true, label: 'Replay Last Prompt' },
      resetOnRepeat: { type: 'boolean', default: false, label: 'Reset Variables on Repeat' }
    },
    validation: {
      required: ['maxRepeats'],
      rules: {
        maxRepeats: { min: 1, max: 10 },
        repeatMessage: { maxLength: 200 },
        fallbackMessage: { maxLength: 200 }
      }
    }
  },

  [NODE_TYPES.END]: {
    name: 'End',
    category: NODE_CATEGORIES.ACTION,
    icon: '🏁',
    description: 'End the call',
    color: '#607D8B',
    inputs: 1,
    outputs: [],
    dataSchema: {
      text: { type: 'string', label: 'Goodbye Message', placeholder: 'Thank you for calling. Goodbye!' },
      terminationType: { type: 'select', options: ['hangup', 'transfer', 'voicemail', 'callback'], default: 'hangup', label: 'Termination Type' },
      transferNumber: { type: 'string', label: 'Transfer Number', placeholder: '+1234567890', condition: { terminationType: 'transfer' } },
      voicemailBox: { type: 'string', label: 'Voicemail Box', condition: { terminationType: 'voicemail' } },
      callbackDelay: { type: 'number', default: 15, min: 1, max: 60, label: 'Callback Delay (minutes)', condition: { terminationType: 'callback' } },
      maxCallbackAttempts: { type: 'number', default: 3, min: 1, max: 10, label: 'Max Callback Attempts' },
      sendSurvey: { type: 'boolean', default: false, label: 'Send Survey' },
      logCall: { type: 'boolean', default: true, label: 'Log Call' },
      sendReceipt: { type: 'boolean', default: false, label: 'Send Receipt' },
      contactMethod: { type: 'select', options: ['sms', 'email', 'whatsapp'], default: 'sms', label: 'Contact Method' },
      // Backend-mapped fields
      reason: { type: 'string', label: 'End Reason' },
      transfer_number: { type: 'string', label: 'Transfer Number' },
      voicemail_box: { type: 'string', label: 'Voicemail Box' },
      callback_delay: { type: 'number', label: 'Callback Delay' },
      max_callback_attempts: { type: 'number', label: 'Max Callback Attempts' },
      send_survey: { type: 'boolean', label: 'Send Survey' },
      log_data: { type: 'boolean', label: 'Log Call Data' },
      send_receipt: { type: 'boolean', label: 'Send Receipt' },
      contact_method: { type: 'string', label: 'Contact Method' }
    },
    validation: {
      rules: {
        text: { maxLength: 500 },
        transferNumber: { pattern: /^\+?[1-9]\d{1,14}$/, condition: { terminationType: 'transfer' } }
      }
    }
  },

  [NODE_TYPES.AI_ASSISTANT]: {
    name: 'AI Assistant',
    category: NODE_CATEGORIES.SERVICE,
    icon: '🤖',
    description: 'Connect to AI assistant for intelligent conversation',
    color: '#00BCD4',
    inputs: 1,
    outputs: ['completed', 'transferred', 'error'],
    dataSchema: {
      streamUrl: { type: 'url', required: true, label: 'WebSocket Stream URL', placeholder: 'ws://localhost:4000/ws' },
      welcomeMessage: { type: 'string', label: 'Welcome Message', placeholder: 'Connecting you to our AI assistant...' },
      maxDuration: { type: 'number', default: 300, min: 60, max: 1800, label: 'Max Conversation Duration (seconds)' },
      language: { type: 'select', options: ['en-US', 'en-GB', 'ta-IN', 'hi-IN'], default: 'en-US', label: 'Conversation Language' },
      voiceProfile: { type: 'select', options: ['professional', 'friendly', 'casual'], default: 'professional', label: 'Voice Profile' },
      contextData: { type: 'object', label: 'Context Variables', placeholder: 'Variables to pass to AI' },
      transferOnHumanRequest: { type: 'boolean', default: true, label: 'Transfer on Human Request' },
      humanTransferDestination: { type: 'string', label: 'Human Transfer Destination', placeholder: '+1234567890', condition: { transferOnHumanRequest: true } }
    },
    validation: {
      required: ['streamUrl'],
      rules: {
        maxDuration: { min: 60, max: 1800 }
      }
    }
  }
};

// Execution Configuration - Consolidated
export const EXECUTION_CONFIG = {
  defaultTimeout: 10000, // 10 seconds
  maxRetries: 3,
  retryDelay: 1000, // 1 second
  safetyLimits: {
    maxNodeExecutions: 200,
    maxLoopIterations: 50,
    maxCallDuration: 30 * 60 * 1000 // 30 minutes
  }
};

// Validation Rules - Consolidated
export const VALIDATION_RULES = {
  nodeId: {
    required: true,
    pattern: /^[a-zA-Z0-9_-]+$/,
    maxLength: 50
  },
  phoneNumber: {
    pattern: /^\+?[1-9]\d{1,14}$/,
    message: 'Must be a valid phone number in E.164 format'
  },
  email: {
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: 'Must be a valid email address'
  },
  url: {
    pattern: /^https?:\/\/.+/,
    message: 'Must be a valid HTTP or HTTPS URL'
  },
  webhookUrl: {
    pattern: /^https?:\/\/.+/,
    message: 'Webhook URLs must use HTTP or HTTPS'
  }
};

// Node Templates - Simplified
export const NODE_TEMPLATES = {
  basicWelcome: {
    type: NODE_TYPES.GREETING,
    data: {
      text: 'Welcome to our company. Press 1 for Sales, 2 for Support, or 3 for Billing.',
      menuOptions: [
        { digit: '1', text: 'Sales' },
        { digit: '2', text: 'Support' },
        { digit: '3', text: 'Billing' }
      ]
    }
  },
  
  audioMessage: {
    type: NODE_TYPES.AUDIO,
    data: {
      mode: 'tts',
      messageText: 'Welcome to our service.',
      voice: 'en-GB-SoniaNeural',
      language: 'en-GB',
      afterPlayback: 'next',
      timeoutSeconds: 10,
      maxRetries: 3
    }
  },
  
  customerService: {
    type: NODE_TYPES.USER_INPUT,
    data: {
      digit: '1',
      label: 'Customer Support',
      action: 'transfer',
      maxAttempts: 3,
      timeoutSeconds: 10
    }
  },
  
  aiAssistant: {
    type: NODE_TYPES.AI_ASSISTANT,
    data: {
      streamUrl: 'ws://localhost:4000/ws',
      welcomeMessage: 'Connecting you to our AI assistant...',
      maxDuration: 300
    }
  }
};

export default {
  NODE_TYPES,
  NODE_CATEGORIES,
  NODE_CONFIGS,
  EXECUTION_CONFIG,
  VALIDATION_RULES,
  NODE_TEMPLATES
};
