/**
 * Clean Workflow Node Configuration
 * Removes duplicate logic and consolidates node configurations
 */

// Node Types
export const NODE_TYPES = {
  GREETING: 'greeting',
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

  [NODE_TYPES.USER_INPUT]: {
    name: 'User Input',
    category: NODE_CATEGORIES.INTERACTION,
    icon: '⌨️',
    description: 'Collect user input via DTMF or speech',
    color: '#2196F3',
    inputs: 1,
    outputs: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#', 'timeout', 'no_match'],
    dataSchema: {
      text: { type: 'string', required: true, label: 'Prompt Text' },
      inputType: { type: 'select', options: ['digits', 'speech', 'both'], default: 'digits', label: 'Input Type' },
      numDigits: { type: 'number', default: 1, min: 1, max: 20, label: 'Number of Digits' },
      finishOnKey: { type: 'string', default: '#', label: 'Finish On Key' },
      speechTimeout: { type: 'number', default: 5, min: 1, max: 30, label: 'Speech Timeout (seconds)' },
      speechModel: { type: 'select', options: ['default', 'phone_number', 'universal'], default: 'default', label: 'Speech Model' },
      timeout: { type: 'number', default: 10, min: 1, max: 60, label: 'Timeout (seconds)' },
      maxRetries: { type: 'number', default: 3, min: 1, max: 10, label: 'Max Retries' },
      invalidInputMessage: { type: 'string', default: 'Invalid input. Please try again.', label: 'Invalid Input Message' }
    },
    validation: {
      required: ['text'],
      rules: {
        text: { minLength: 1, maxLength: 500 },
        timeout: { min: 1, max: 60 },
        maxRetries: { min: 1, max: 10 }
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
      variable: { type: 'string', required: true, label: 'Variable Name' },
      operator: { type: 'select', options: ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'exists', 'regex'], default: 'equals', label: 'Operator' },
      value: { type: 'string', required: true, label: 'Value' },
      customVariableName: { type: 'string', label: 'Custom Variable Name' },
      caseSensitive: { type: 'boolean', default: false, label: 'Case Sensitive' },
      truePathMessage: { type: 'string', label: 'True Path Message' },
      falsePathMessage: { type: 'string', label: 'False Path Message' }
    },
    validation: {
      required: ['variable', 'operator', 'value'],
      rules: {
        variable: { minLength: 1, maxLength: 100 },
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
      text: { type: 'string', required: true, label: 'Voicemail Prompt' },
      maxLength: { type: 'number', default: 60, min: 1, max: 300, label: 'Max Length (seconds)' },
      transcribe: { type: 'boolean', default: true, label: 'Transcribe Recording' },
      playBeep: { type: 'boolean', default: true, label: 'Play Beep' },
      recordingUrl: { type: 'url', label: 'Recording Webhook URL' },
      emailNotifications: { type: 'array', label: 'Email Notifications', itemSchema: { email: { type: 'email', required: true, label: 'Email Address' }, conditions: { type: 'string', label: 'Send Conditions' } } },
      silenceTimeout: { type: 'number', default: 5, min: 1, max: 30, label: 'Silence Timeout (seconds)' }
    },
    validation: {
      required: ['text'],
      rules: {
        text: { minLength: 1, maxLength: 500 },
        maxLength: { min: 1, max: 300 },
        silenceTimeout: { min: 1, max: 30 }
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
      announceText: { type: 'string', label: 'Announcement Text', placeholder: 'Transferring you now...' },
      timeout: { type: 'number', default: 30, min: 10, max: 120, label: 'Ring Timeout (seconds)' },
      callerId: { type: 'string', label: 'Caller ID', placeholder: '+1234567890' },
      record: { type: 'boolean', default: false, label: 'Record Transfer' },
      musicOnHold: { type: 'select', options: ['default', 'none', 'custom'], default: 'default', label: 'Music on Hold' },
      customMusicUrl: { type: 'url', label: 'Custom Music URL', placeholder: 'https://example.com/music.mp3', condition: { musicOnHold: 'custom' } },
      transferMode: { type: 'select', options: ['blind', 'attended'], default: 'blind', label: 'Transfer Mode' }
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
      reason: { type: 'select', options: ['normal', 'error', 'timeout', 'hangup'], default: 'normal', label: 'End Reason' },
      logData: { type: 'boolean', default: true, label: 'Log Call Data' },
      sendSummary: { type: 'boolean', default: false, label: 'Send Call Summary' },
      summaryEmail: { type: 'email', label: 'Summary Email', placeholder: 'summary@example.com', condition: { sendSummary: true } }
    },
    validation: {
      rules: {
        text: { maxLength: 500 }
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
  
  customerService: {
    type: NODE_TYPES.USER_INPUT,
    data: {
      text: 'Please enter your selection.',
      inputType: 'digits',
      numDigits: 1
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
