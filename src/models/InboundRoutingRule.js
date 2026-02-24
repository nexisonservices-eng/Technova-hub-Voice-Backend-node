import mongoose from 'mongoose';

const inboundRoutingRuleSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    priority: {
      type: Number,
      default: 1,
      min: 1
    },
    condition: {
      type: String,
      required: true,
      trim: true
    },
    action: {
      type: String,
      required: true,
      trim: true
    },
    actionType: {
      type: String,
      enum: ['custom', 'ivr'],
      default: 'custom'
    },
    ivrMenuId: {
      type: String,
      trim: true,
      default: ''
    },
    ivrPromptKey: {
      type: String,
      trim: true,
      default: ''
    },
    enabled: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

inboundRoutingRuleSchema.index({ priority: 1 });
inboundRoutingRuleSchema.index({ updatedAt: -1 });
inboundRoutingRuleSchema.index({ userId: 1, priority: 1, updatedAt: -1 });

const InboundRoutingRule = mongoose.model('InboundRoutingRule', inboundRoutingRuleSchema);

export default InboundRoutingRule;
