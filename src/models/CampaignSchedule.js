import mongoose from 'mongoose';

const abTestGroupSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, required: true },
    template: { type: String, trim: true, required: true },
    allocated: { type: Number, default: 0 },
    initiated: { type: Number, default: 0 },
    failed: { type: Number, default: 0 }
  },
  { _id: false }
);

const campaignScheduleSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    campaignId: {
      type: String,
      trim: true,
      required: true,
      index: true
    },
    campaignName: {
      type: String,
      trim: true,
      required: true
    },
    fromNumbers: {
      type: [String],
      default: []
    },
    numbers: {
      type: [String],
      default: []
    },
    cronExpression: {
      type: String,
      trim: true,
      required: true
    },
    timezone: {
      type: String,
      default: 'Asia/Kolkata'
    },
    recurrence: {
      type: String,
      enum: ['once', 'daily', 'weekly'],
      default: 'once'
    },
    retryCount: {
      type: Number,
      default: 0
    },
    retryGapHours: {
      type: Number,
      default: 2
    },
    maxRetries: {
      type: Number,
      default: 3
    },
    abTestEnabled: {
      type: Boolean,
      default: false
    },
    abTestGroups: {
      type: [abTestGroupSchema],
      default: []
    },
    winnerGroup: {
      type: String,
      default: ''
    },
    status: {
      type: String,
      enum: ['active', 'paused', 'completed', 'failed'],
      default: 'active'
    },
    pausedAt: Date,
    lastRunAt: Date,
    nextRunAt: Date,
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true
  }
);

campaignScheduleSchema.index({ userId: 1, campaignName: 1, cronExpression: 1, status: 1 });

const CampaignSchedule = mongoose.model('CampaignSchedule', campaignScheduleSchema);
export default CampaignSchedule;
