import 'dotenv/config'; // Load environment variables from .env
import http from 'http';
import { Server } from 'socket.io';
import app from "./src/app.js";
import { initializeSocketIO, shutdownSocketIO } from './src/sockets/unifiedSocket.js';
import campaignAutomationService from './src/services/campaignAutomationService.js';

import { connectDB } from "./src/config/db.js";
import logger from "./src/utils/logger.js";

// ===== STARTUP SEQUENCE =====
logger.info(' Starting Technovo Voice Backend...');

// 1. Connect to MongoDB
logger.info('📡 Connecting to MongoDB...');
await connectDB();
logger.info('MongoDB connected');
const restoredSchedules = await campaignAutomationService.initializeScheduledTasks();
logger.info(`Restored ${restoredSchedules} active campaign schedule(s)`);

// 2. Initialize Twilio (lazy initialization - will log when first used)
logger.info('📞 Initializing Twilio Service...');

// 3. Create HTTP Server
logger.info('🌐 Creating HTTP Server...');
const server = http.createServer(app);

// 4. Initialize Socket.IO
logger.info('🔌 Initializing Socket.IO...');
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

initializeSocketIO(io);
logger.info('✅ Socket.IO ready');

// 5. Start Health Check
logger.info('🏥 Starting Health Check...');

// ⚠️ Check for valid BASE_URL (Critical for Twilio Webhooks)
if (!process.env.BASE_URL || process.env.BASE_URL.includes('localhost')) {
  logger.warn('╔════════════════════════════════════════════════════════════╗');
  logger.warn('║ CRITICAL WARNING: BASE_URL is missing or uses localhost!   ║');
  logger.warn('║ Twilio webhooks (Error 11200) WILL FAIL.                   ║');
  logger.warn('║ USE NGROK OR PUBLIC URL: e.g. https://xyz.ngrok-free.app   ║');
  logger.warn('╚════════════════════════════════════════════════════════════╝');
}

// Graceful shutdown function
const shutdown = async () => {
  logger.info('🛑 Shutting down server...');
  shutdownSocketIO();

  server.close(() => {
    logger.info('🛑 HTTP server closed');
    process.exit(0);
  });

  // Force exit after 5s if server doesn't close
  setTimeout(() => {
    logger.warn('⚠️ Forcing shutdown');
    process.exit(1);
  }, 5000);
};

// Capture shutdown signals
process.on('SIGINT', shutdown);   // CTRL+C
process.on('SIGTERM', shutdown);  // Docker / PM2

// Start server with port error handling
server.listen(process.env.PORT || 5000, () => {
  const port = process.env.PORT || 5000;
  logger.info(`🌐 Server running on port ${port}`);
  logger.info(`📡 Health check available at: http://localhost:${port}/health`);
  logger.info(`🔌 Socket.IO ready for connections`);
  logger.info(`📞 Twilio service initialized (lazy)`);
  logger.info('==============================');
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`❌ Port ${process.env.PORT || 5000} already in use`);
    process.exit(1); // Exit so nodemon can restart
  } else {
    throw err;
  }
});

