import mongoose from 'mongoose';

const leadSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true, // Owner of the lead (system admin/agent)
        index: true
    },
    callSid: {
        type: String,
        required: true,
        index: true
    },
    workflowId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Workflow',
        index: true
    },
    workflowName: {
        type: String,
        trim: true
    },
    caller: {
        phoneNumber: {
            type: String,
            required: true,
            index: true
        },
        name: {
            type: String,
            trim: true
        }
    },
    intent: {
        type: String,
        enum: ['booking', 'inquiry', 'support', 'other'],
        default: 'booking',
        index: true
    },
    status: {
        type: String,
        enum: ['PENDING_AGENT', 'IN_PROGRESS', 'CONFIRMED', 'CANCELLED', 'COMPLETED'],
        default: 'PENDING_AGENT',
        index: true
    },
    bookingDetails: {
        serviceType: String,
        roomType: String,
        checkIn: Date,
        checkOut: Date,
        startTime: Date,
        endTime: Date,
        notes: String,
        preferences: Map
    },
    audioRecordings: [{
        type: {
            type: String,
            enum: ['name_input', 'service_input', 'time_input', 'confirmation']
        },
        url: String, // Cloudinary URL
        publicId: String,
        duration: Number,
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    aiAnalysis: {
        transcription: String,
        summary: String,
        sentiment: String,
        confidenceScore: Number
    },
    assignedAgent: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    isRead: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Virtual for formatted duration
leadSchema.virtual('durationFormatted').get(function () {
    if (!this.duration) return '0:00';
    const minutes = Math.floor(this.duration / 60);
    const seconds = this.duration % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
});

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;
