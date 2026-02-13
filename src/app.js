import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import logger from "./utils/logger.js";
import voiceRoutes from "./routes/VoiceRoutes.js";
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

import path from 'path';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// Serve static files from the uploads directory
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Routes
app.use('/voice', voiceRoutes);
app.use('/broadcast', BroadcastRoutes);
app.use('/webhook/broadcast', BroadcastRoutes); // Add webhook prefix for Twilio callbacks
app.use('/ai', AIRoutes);
app.use('/health', OptimizedHealthRoutes);
app.use('/webhook', InboundRoutes); // Inbound call webhooks
app.use('/inbound', InboundRoutes); // Management endpoints
app.use('/api/ivr', IVRRoutes); // IVR management endpoints
app.use('/ivr', IVRRoutes); // TwiML callback compatibility routes
app.use('/api/workflow', workflowRoutes); // Workflow management endpoints
app.use('/workflow', workflowRoutes); // Frontend compatibility endpoints
app.use('/webhook/twilio', twilioWebhookRoutes); // Twilio webhooks
app.use('/webhook/legacy', legacyWebhookRoutes); // Legacy compatibility webhooks
app.use('/api/call-logs', CallLogRoutes); // Call log management
app.use('/api/outbound-config', OutboundConfigRoutes); // Outbound configuration
app.use('/api/leads', LeadRoutes); // Lead management (semi-automated bookings)

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Voice Automation Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

export default app;
