import dotenv from 'dotenv';
dotenv.config();

export default {
  // Server
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 3000,

  // MongoDB
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/voice_automation',

  // Python AI Service
  AI_SERVICE_URL: process.env.AI_SERVICE_URL || 'wss://technova-hub-voice-backend-python.onrender.com',
  AI_SERVICE_HTTP: process.env.AI_SERVICE_HTTP || 'https://technova-hub-voice-backend-python.onrender.com',

  // Twilio
//   TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
//   TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
//   TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,

  // Exotel (Alternative)
  EXOTEL_API_KEY: process.env.EXOTEL_API_KEY,
  EXOTEL_API_TOKEN: process.env.EXOTEL_API_TOKEN,
  EXOTEL_SID: process.env.EXOTEL_SID,
  EXOTEL_APP_ID: process.env.EXOTEL_APP_ID,

  // JWT
  JWT_SECRET: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  JWT_EXPIRE: process.env.JWT_EXPIRE || '7d',

  // Base URL (for webhooks)
  /*BASE_URL: process.env.BASE_URL || 'http://localhost:3000',*/

  // Telephony Provider (twilio or exotel)
  TELEPHONY_PROVIDER: process.env.TELEPHONY_PROVIDER || 'twilio',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_DIR: process.env.LOG_DIR || 'logs',

  // Features
  ENABLE_CHAT: process.env.ENABLE_CHAT === 'true',
  ENABLE_VOICE: process.env.ENABLE_VOICE !== 'false',
  ENABLE_RECORDING: process.env.ENABLE_RECORDING === 'true',
};
