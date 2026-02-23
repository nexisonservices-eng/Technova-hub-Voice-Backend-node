import mongoose from 'mongoose';

const broadcastCallSchema = new mongoose.Schema(
  {
    broadcast: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Broadcast',
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },

    contact: {
      phone: {
        type: String,
        required: true,
        index: true
      },
      name: String,
      customFields: mongoose.Schema.Types.Mixed
    },

    personalizedMessage: {
      text: String,             // Final message after template substitution
      audioUrl: String,         // CDN URL for this specific message
      audioAssetId: mongoose.Schema.Types.ObjectId // Reference to Broadcast.audioAssets
    },

    // Twilio call details
    callSid: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },

    status: {
      type: String,
      enum: [
        'queued',
        'calling',
        'ringing',
        'in_progress',
        'answered',
        'completed',
        'failed',
        'busy',
        'no_answer',
        'cancelled',
        'opted_out'
      ],
      default: 'queued',
      index: true
    },

    // Retry tracking
    attempts: {
      type: Number,
      default: 0
    },
    retryAfter: Date,

    // Call metrics
    duration: Number,   // seconds
    startTime: Date,
    answerTime: Date,
    endTime: Date,

    // Twilio response data
    twilioStatus: String,
    twilioError: {
      code: Number,
      message: String
    },

    // DND / Compliance
    dndStatus: {
      type: String,
      enum: ['allowed', 'blocked', 'unchecked'],
      default: 'unchecked'
    },
    optedOut: {
      type: Boolean,
      default: false
    },

    // Audio playback tracking
    audioPlayed: {
      type: Boolean,
      default: false
    },
    audioPlayedAt: Date,

    metadata: mongoose.Schema.Types.Mixed
  },
  {
    timestamps: true
  }
);

// Indexes
broadcastCallSchema.index({ broadcast: 1, status: 1 });
broadcastCallSchema.index({ broadcast: 1, attempts: 1, retryAfter: 1 });
broadcastCallSchema.index({ userId: 1, createdAt: -1 });

// Instance methods
broadcastCallSchema.methods.markCalling = async function (callSid) {
  this.callSid = callSid;
  this.status = 'calling';
  this.startTime = new Date();
  this.attempts += 1;
  await this.save();
};

broadcastCallSchema.methods.markCompleted = async function (duration) {
  this.status = 'completed';
  this.endTime = new Date();
  this.duration = duration;
  await this.save();
};

broadcastCallSchema.methods.markFailed = async function (
  errorCode,
  errorMsg,
  shouldRetry = true
) {
  this.status = 'failed';
  this.endTime = new Date();
  this.twilioError = {
    code: errorCode,
    message: errorMsg
  };

  // Schedule retry if eligible
  if (shouldRetry && this.attempts < 2) {
    const Broadcast = mongoose.model('Broadcast');
    const broadcast = await Broadcast.findById(this.broadcast);

    this.retryAfter = new Date(
      Date.now() + (broadcast?.config?.retryDelay || 300000)
    );
    this.status = 'queued';
  }

  await this.save();
};

broadcastCallSchema.methods.markOptedOut = async function () {
  this.status = 'opted_out';
  this.optedOut = true;
  this.endTime = new Date();
  await this.save();
};

// Static methods
broadcastCallSchema.statics.getRetryableCalls = async function (broadcastId) {
  return this.find({
    broadcast: broadcastId,
    status: 'queued',
    attempts: { $lt: 2 },
    retryAfter: { $lte: new Date() }
  }).limit(50);
};

const BroadcastCall = mongoose.model('BroadcastCall', broadcastCallSchema);
export default BroadcastCall;
