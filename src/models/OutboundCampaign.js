import mongoose from 'mongoose';

const outboundCampaignSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    campaignId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    provider: {
      type: String,
      enum: ['exotel', 'twilio'],
      default: 'exotel',
      index: true
    },
    mode: {
      type: String,
      enum: ['immediate', 'scheduled', 'recurring'],
      default: 'immediate'
    },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'failed', 'partial'],
      default: 'draft',
      index: true
    },
    fromNumber: {
      type: String,
      trim: true,
      default: ''
    },
    message: {
      type: String,
      trim: true,
      default: ''
    },
    voice: {
      voiceId: { type: String, trim: true, default: '' },
      provider: { type: String, trim: true, default: 'edge' },
      language: { type: String, trim: true, default: 'en-GB' }
    },
    ivrWorkflow: {
      workflowId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Workflow',
        default: null,
        index: true
      },
      workflowName: {
        type: String,
        trim: true,
        default: ''
      },
      reuseInboundFlow: {
        type: Boolean,
        default: true
      }
    },
    schedule: {
      enabled: { type: Boolean, default: false },
      scheduleType: {
        type: String,
        enum: ['immediate', 'once', 'recurring'],
        default: 'immediate'
      },
      scheduledAt: { type: Date, default: null },
      recurrence: {
        type: String,
        enum: ['none', 'daily', 'weekly'],
        default: 'none'
      },
      cronExpression: { type: String, trim: true, default: '' },
      timezone: { type: String, trim: true, default: 'Asia/Kolkata' },
      allowedWindowStart: { type: String, trim: true, default: '09:00' },
      allowedWindowEnd: { type: String, trim: true, default: '21:00' },
      scheduleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'CampaignSchedule',
        default: null
      },
      nextRunAt: { type: Date, default: null },
      lastRunAt: { type: Date, default: null }
    },
    contactSummary: {
      total: { type: Number, default: 0 },
      pending: { type: Number, default: 0 },
      contacted: { type: Number, default: 0 },
      answered: { type: Number, default: 0 },
      failed: { type: Number, default: 0 }
    },
    metrics: {
      initiated: { type: Number, default: 0 },
      ringing: { type: Number, default: 0 },
      answered: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      busy: { type: Number, default: 0 },
      noAnswer: { type: Number, default: 0 },
      ivrInteractions: { type: Number, default: 0 },
      lastStatusAt: { type: Date, default: null }
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true
  }
);

outboundCampaignSchema.index({ userId: 1, createdAt: -1 });
outboundCampaignSchema.index({ userId: 1, status: 1, provider: 1 });

const OutboundCampaign = mongoose.model('OutboundCampaign', outboundCampaignSchema);
export default OutboundCampaign;
