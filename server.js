import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import app from './src/app.js';
import { initializeSocketIO, shutdownSocketIO } from './src/sockets/unifiedSocket.js';
import { connectDB } from './src/config/db.js';
import logger from './src/utils/logger.js';

const normalizeOrigin = (origin = '') => origin.trim().replace(/\/+$/, '');

const parseAllowedOrigins = () => {
  const rawOrigins = process.env.CORS_ORIGIN || process.env.CORS_ORIGINS || '';
  const configured = rawOrigins
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

  const envFrontends = [
    process.env.FRONTEND_URL,
    process.env.FRONTEND_BASE_URL,
    process.env.ADMIN_FRONTEND_URL
  ]
    .map(normalizeOrigin)
    .filter(Boolean);

  const deduped = Array.from(new Set([...configured, ...envFrontends]));

  if (deduped.length > 0) {
    return deduped;
  }

  return [];
};

const allowedOrigins = parseAllowedOrigins();
const PORT = Number(process.env.PORT) || 5000;
const isProduction = process.env.NODE_ENV === 'production';
const hasWildcardOrigin = allowedOrigins.includes('*');

if (!isProduction && allowedOrigins.length === 0) {
  logger.warn('No explicit CORS origins configured for Socket.IO. Cross-origin web clients may fail to connect.');
}

logger.info('Starting Technovo Voice Backend');
logger.info('Connecting to MongoDB');
await connectDB();
logger.info('MongoDB connected');

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: hasWildcardOrigin ? '*' : allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: !hasWildcardOrigin
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

initializeSocketIO(io);
app.set('io', io);
logger.info('Socket.IO ready');

if (!process.env.BASE_URL || process.env.BASE_URL.includes('localhost')) {
  logger.warn('BASE_URL is missing or points to localhost, Twilio webhooks may fail in production');
}

let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Shutting down server');

  try {
    shutdownSocketIO();
  } catch (error) {
    logger.error('Error while shutting down Socket.IO', { error: error.message });
  }

  server.close((error) => {
    if (error) {
      logger.error('Error while closing HTTP server', { error: error.message });
      process.exit(1);
      return;
    }
    logger.info('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason });
  if (isProduction) {
    shutdown();
  }
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { message: error.message, stack: error.stack });
  shutdown();
});

server
  .listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Health check: http://localhost:${PORT}/health`);
  })
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${PORT} already in use`);
      process.exit(1);
      return;
    }
    throw err;
  });


