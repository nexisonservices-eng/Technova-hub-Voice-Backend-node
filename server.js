import 'dotenv/config'; // Load environment variables from .env
import http from 'http';
import { Server } from 'socket.io';
import app from './src/app.js';
import { initializeSocketIO, shutdownSocketIO } from './src/sockets/unifiedSocket.js';
import campaignAutomationService from './src/services/campaignAutomationService.js';
import { connectDB } from './src/config/db.js';
import logger from './src/utils/logger.js';

// ===== STARTUP SEQUENCE =====
logger.info('Starting Technovo Voice Backend...');

// Create HTTP server first so lightweight routes like /health are reachable immediately.
logger.info('Creating HTTP server...');
const server = http.createServer(app);

// Initialize Socket.IO.
logger.info('Initializing Socket.IO...');
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

initializeSocketIO(io);
logger.info('Socket.IO ready');

// Start listening right away so /health is always available.
const port = process.env.PORT || 5000;
server.listen(port, () => {
  logger.info(`Server running on port ${port}`);
  logger.info(`Health check available at: http://localhost:${port}/health`);
  logger.info('Socket.IO ready for connections');
  logger.info('Twilio service initialized (lazy)');
  logger.info('==============================');
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${process.env.PORT || 5000} already in use`);
    process.exit(1);
  }

  throw err;
});

// Bootstrap background services without blocking HTTP availability.
void (async () => {
  try {
    logger.info('Connecting to MongoDB...');
    await connectDB();
    logger.info('MongoDB connected');

    const restoredSchedules = await campaignAutomationService.initializeScheduledTasks();
    logger.info(`Restored ${restoredSchedules} active campaign schedule(s)`);

    // Twilio remains lazy, but we keep the log for startup parity.
    logger.info('Initializing Twilio Service...');
  } catch (error) {
    logger.error('Startup bootstrap failed:', error);
  }
})();

// Optional startup warning for webhook configuration.
if (!process.env.BASE_URL || process.env.BASE_URL.includes('localhost')) {
  logger.warn('BASE_URL is missing or uses localhost.');
  logger.warn('Twilio webhooks will fail until a public BASE_URL is configured.');
}

// Graceful shutdown function.
const shutdown = async () => {
  logger.info('Shutting down server...');
  shutdownSocketIO();

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 5s if server doesn't close.
  setTimeout(() => {
    logger.warn('Forcing shutdown');
    process.exit(1);
  }, 5000);
};

// Capture shutdown signals.
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
