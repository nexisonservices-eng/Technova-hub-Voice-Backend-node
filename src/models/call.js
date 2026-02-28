import mongoose from 'mongoose';

const callSchema = new mongoose.Schema(
  {
    callSid: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    phoneNumber: {
      type: String,
      required: true
    },
    direction: {
      type: String,
      enum: ['inbound', 'outbound'],
      required: true
    },
    status: {
      type: String,
      enum: [
        'initiated',
        'ringing',
        'in-progress',
        'completed',
        'failed',
        'busy',
        'no-answer'
      ],
      default: 'initiated'
    },
    duration: {
      type: Number, // seconds
      default: 0
    },
    startTime: Date,
    endTime: Date,
    recording: {
      enabled: {
        type: Boolean,
        default: false
      },
      url: String,
      duration: Number
    },
    conversation: [
      {
        type: {
          type: String,
          enum: ['user', 'ai']
        },
        text: String,
        audio: String,
        timestamp: {
          type: Date,
          default: Date.now
        },
        duration: Number
      }
    ],
    aiMetrics: {
      totalExchanges: {
        type: Number,
        default: 0
      },
      avgResponseTime: Number,
      sttDuration: Number,
      aiDuration: Number,
      ttsDuration: Number,
      totalTokens: Number
    },
    provider: {
      type: String,
      enum: ['twilio'],
      required: true
    },
    providerData: mongoose.Schema.Types.Mixed,
    error: {
      code: String,
      message: String
    },
    routing: {
      type: String,
      enum: ['default', 'ivr', 'sales', 'tech', 'billing', 'ai', 'voicemail', 'callback'],
      default: 'default'
    },
    queued: {
      type: Boolean,
      default: false,
      index: true
    },
    queueName: {
      type: String,
      trim: true,
      default: ''
    },
    queuePosition: {
      type: Number,
      default: 0
    },
    queueWaitTime: {
      type: Number,
      default: 0
    },
    tags: [String],
    notes: String,
    deletedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

/* ======================
   Indexes
====================== */

callSchema.index({ user: 1, createdAt: -1 });
callSchema.index({ phoneNumber: 1 });
callSchema.index({ status: 1 });
callSchema.index({ direction: 1 });
callSchema.index({ createdAt: -1, status: 1, direction: 1 }); // Compound index for filtering
callSchema.index({ deletedAt: 1 }); // For soft delete queries

/* ======================
   Instance Methods
====================== */

// End call and calculate duration
callSchema.methods.endCall = async function () {
  this.endTime = new Date();

  if (this.startTime) {
    this.duration = Math.floor(
      (this.endTime - this.startTime) / 1000
    );
  }

  this.status = 'completed';
  await this.save();
};

// Add conversation entry
callSchema.methods.addConversation = async function (
  type,
  text,
  audio = null
) {
  this.conversation.push({
    type,
    text,
    audio,
    timestamp: new Date()
  });

  if (type === 'ai') {
    this.aiMetrics.totalExchanges += 1;
  }

  await this.save();
};

// Update AI metrics
callSchema.methods.updateAIMetrics = async function (metrics) {
  this.aiMetrics = {
    ...this.aiMetrics,
    ...metrics
  };

  await this.save();
};

const Call = mongoose.model('Call', callSchema);
export default Call;
