import mongoose from 'mongoose';

const broadcastSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },

    messageTemplate: {
      type: String,
      required: true
      // "Hi {{name}}, we have a {{offer}} for you!"
    },

    voice: {
      provider: {
        type: String,
        default: 'edge',
        enum: ['edge', 'elevenlabs']
      },
      voiceId: {
        type: String,
        required: true,
        enum: [
          'ta-IN-PallaviNeural',      // Tamil – Female
          'ta-IN-ValluvarNeural',      // Tamil – Male
          'en-GB-SoniaNeural',        // British English – Female
          'en-GB-RyanNeural'          // British English – Male
        ]
        // Limited to 4 specified voices
      },
      language: {
        type: String,
        enum: ['ta-IN', 'en-GB'], // Tamil or British English
        default: 'ta-IN'
      }
    },

    contacts: [
      {
        phone: {
          type: String,
          required: true
        },
        name: String,
        customFields: mongoose.Schema.Types.Mixed
        // { offer: "Diwali discount", city: "Mumbai" }
      }
    ],

    // Audio files generated (deduplicated by unique message)
    audioAssets: [
      {
        uniqueKey: String, // Hash of personalized message
        text: String,      // Actual personalized text
        audioUrl: String,  // CDN URL
        duration: Number,  // seconds
        generatedAt: Date
      }
    ],

    status: {
      type: String,
      enum: ['draft', 'queued', 'in_progress', 'completed', 'cancelled'],
      default: 'draft'
    },

    stats: {
      total: { type: Number, default: 0 },
      queued: { type: Number, default: 0 },
      calling: { type: Number, default: 0 },
      answered: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      opted_out: { type: Number, default: 0 }
    },

    config: {
      maxConcurrent: {
        type: Number,
        default: 50
      },
      maxRetries: {
        type: Number,
        default: 2
      },
      retryDelay: {
        type: Number,
        default: 300000 // 5 minutes in ms
      },
      compliance: {
        disclaimerText: {
          type: String,
          default: 'This is an automated call from'
        },
        optOutEnabled: {
          type: Boolean,
          default: true
        },
        dndRespect: {
          type: Boolean,
          default: true
        }
      }
    },

    scheduledAt: Date,
    startedAt: Date,
    completedAt: Date,

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    outboundCampaigns: [
      {
        campaignId: {
          type: String,
          trim: true
        },
        name: {
          type: String,
          trim: true
        },
        provider: {
          type: String,
          enum: ['exotel'],
          default: 'exotel'
        },
        total: {
          type: Number,
          default: 0
        },
        initiated: {
          type: Number,
          default: 0
        },
        failed: {
          type: Number,
          default: 0
        },
        createdAt: {
          type: Date,
          default: Date.now
        }
      }
    ],

    scheduleConfig: {
      enabled: { type: Boolean, default: false },
      cronExpression: { type: String, trim: true, default: '' },
      recurrence: {
        type: String,
        enum: ['once', 'daily', 'weekly'],
        default: 'once'
      },
      timezone: { type: String, default: 'Asia/Kolkata' },
      lastScheduledAt: Date
    },

    retryConfig: {
      enabled: { type: Boolean, default: true },
      maxRetries: { type: Number, default: 3 },
      retryGapHours: { type: Number, default: 2 },
      lastRetryRunAt: Date
    },

    abTestConfig: {
      enabled: { type: Boolean, default: false },
      autoWinner: { type: Boolean, default: true },
      winnerTemplate: { type: String, trim: true, default: '' },
      groups: [
        {
          key: { type: String, trim: true },
          template: { type: String, trim: true },
          initiated: { type: Number, default: 0 },
          failed: { type: Number, default: 0 }
        }
      ]
    }
  },
  {
    timestamps: true
  }
);

// Indexes
broadcastSchema.index({ status: 1, createdAt: -1 });
broadcastSchema.index({ createdBy: 1 });

// Methods
broadcastSchema.methods.incrementStat = async function (statKey) {
  this.stats[statKey] += 1;
  await this.save();
};

broadcastSchema.methods.updateStatus = async function (newStatus) {
  this.status = newStatus;

  if (newStatus === 'in_progress' && !this.startedAt) {
    this.startedAt = new Date();
  }

  if (newStatus === 'completed' || newStatus === 'cancelled') {
    this.completedAt = new Date();
  }

  await this.save();
};

const Broadcast = mongoose.model('Broadcast', broadcastSchema);
export default Broadcast;
