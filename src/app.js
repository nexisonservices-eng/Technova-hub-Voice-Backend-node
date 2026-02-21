import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import logger from "./utils/logger.js";
import voiceRoutes from "./routes/voiceRoutes.js";
import BroadcastRoutes from "./routes/broadcastRoutes.js";
import AIRoutes from "./routes/aiRoutes.js";
import OptimizedHealthRoutes from "./routes/optimizedHealthRoutes.js";
import InboundRoutes from "./routes/inboundRoutes.js";
import IVRRoutes from "./routes/ivrRoutes.js";
import workflowRoutes from "./routes/workflowRoutes.js";
import twilioWebhookRoutes from './routes/twilioWebhookRoutes.js';
import legacyWebhookRoutes from './routes/legacyWebhookRoutes.js';
import CallLogRoutes from "./routes/callLogRoutes.js";
import OutboundConfigRoutes from "./routes/outboundConfigRoutes.js";
import LeadRoutes from "./routes/leadRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import callDetailsRoutes from "./routes/callDetailsRoutes.js";

import path from 'path';

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

const app = express();
const allowedOrigins = parseAllowedOrigins();

// Middleware
app.set('trust proxy', 1);
const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes('*')) {
      return callback(null, true);
    }

    const normalizedOrigin = normalizeOrigin(origin);
    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Serve static files from the uploads directory
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Routes
app.use('/voice', voiceRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/broadcast', BroadcastRoutes);
app.use('/webhook/broadcast', BroadcastRoutes); // Add webhook prefix for Twilio callbacks
app.use('/ai', AIRoutes);
app.use('/health', OptimizedHealthRoutes);
app.use('/webhook', InboundRoutes); // Inbound call webhooks
app.use('/inbound', InboundRoutes); // Management endpoints
app.use('/api/inbound', InboundRoutes); // Frontend compatibility endpoints
app.use('/api/ivr', IVRRoutes); // IVR management endpoints
app.use('/ivr', IVRRoutes); // TwiML callback compatibility routes
app.use('/api/workflow', workflowRoutes); // Workflow management endpoints
app.use('/workflow', workflowRoutes); // Frontend compatibility endpoints
app.use('/webhook/twilio', twilioWebhookRoutes); // Twilio webhooks
app.use('/webhook/legacy', legacyWebhookRoutes); // Legacy compatibility webhooks
app.use('/api/call-logs', CallLogRoutes); // Call log management
app.use('/api/outbound-config', OutboundConfigRoutes); // Outbound configuration
app.use('/api/leads', LeadRoutes); // Lead management (semi-automated bookings)
app.use('/api/analytics', analyticsRoutes); // Analytics endpoints
app.use('/api/calls', callDetailsRoutes); // Call details endpoints

// Health check


app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Voice Automation Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.originalUrl} not found`
    },
    timestamp: new Date().toISOString()
  });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled application error', {
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl
  });

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: {
      code: statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR',
      message: statusCode === 500 ? 'Internal server error' : err.message
    },
    timestamp: new Date().toISOString()
  });
});

export default app;


