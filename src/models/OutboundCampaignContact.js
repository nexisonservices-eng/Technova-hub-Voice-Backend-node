import mongoose from 'mongoose';

const responseSchema = new mongoose.Schema(
  {
    nodeId: { type: String, trim: true, default: '' },
    input: { type: String, trim: true, default: '' },
    timestamp: { type: Date, default: Date.now }
  },
  { _id: false }
);

const outboundCampaignContactSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OutboundCampaign',
      required: true,
      index: true
    },
    campaignKey: {
      type: String,
      trim: true,
      required: true,
      index: true
    },
    phone: {
      type: String,
      trim: true,
      required: true,
      index: true
    },
    name: {
      type: String,
      trim: true,
      default: ''
    },
    customFields: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    status: {
      type: String,
      enum: ['pending', 'initiated', 'ringing', 'answered', 'completed', 'failed', 'busy', 'no-answer'],
      default: 'pending',
      index: true
    },
    attempts: {
      type: Number,
      default: 0
    },
    lastAttemptAt: {
      type: Date,
      default: null
    },
    lastCallSid: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    workflowExecutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExecutionLog',
      default: null
    },
    responses: {
      type: [responseSchema],
      default: []
    },
    responseSummary: {
      lastInput: { type: String, trim: true, default: '' },
      inputCount: { type: Number, default: 0 },
      interacted: { type: Boolean, default: false }
    }
  },
  {
    timestamps: true
  }
);

outboundCampaignContactSchema.index({ campaignId: 1, status: 1 });
outboundCampaignContactSchema.index({ campaignId: 1, phone: 1 }, { unique: true });

const OutboundCampaignContact = mongoose.model('OutboundCampaignContact', outboundCampaignContactSchema);
export default OutboundCampaignContact;
