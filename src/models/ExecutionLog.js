import mongoose from 'mongoose';

const ExecutionLogSchema = new mongoose.Schema({
    // Call identification
    callSid: {
        type: String,
        required: true,
        index: true,
        description: 'Twilio Call SID'
    },

    // Workflow reference
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: false,
        index: true,
        description: 'Owner userId from Admin backend'
    },

    workflowId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Workflow',
        required: true,
        index: true,
        description: 'Reference to Workflow'
    },

    workflowName: {
        type: String,
        description: 'Workflow name for quick reference'
    },

    // Execution timing
    startTime: {
        type: Date,
        required: true,
        default: Date.now,
        index: true
    },

    endTime: {
        type: Date,
        index: true
    },

    duration: {
        type: Number,
        description: 'Execution duration in milliseconds'
    },

    // Execution status
    status: {
        type: String,
        enum: ['running', 'completed', 'failed', 'timeout', 'abandoned'],
        default: 'running',
        index: true
    },

    // Termination reason
    reason: {
        type: String,
        enum: ['normal', 'error', 'timeout', 'max_iterations', 'user_hangup', 'transfer_complete'],
        description: 'Why the execution ended'
    },

    errorMessage: {
        type: String,
        description: 'Error message if execution failed'
    },

    // Execution path
    visitedNodes: [{
        nodeId: String,
        nodeType: String,
        timestamp: Date,
        userInput: String,
        duration: Number
    }],

    // Execution context
    variables: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
        description: 'Runtime variables during execution'
    },

    // Execution statistics
    nodeExecutionCount: {
        type: Number,
        default: 0,
        description: 'Total nodes executed'
    },

    loopIterations: {
        type: Number,
        default: 0,
        description: 'Number of loop iterations detected'
    },

    // User interaction
    userInputs: [{
        nodeId: String,
        input: String,
        timestamp: Date
    }],

    // Call metadata
    callerNumber: {
        type: String,
        description: 'Caller phone number'
    },

    destinationNumber: {
        type: String,
        description: 'Number called'
    },

    // Analytics
    transferAttempted: {
        type: Boolean,
        default: false
    },

    transferDestination: {
        type: String
    },

    voicemailRecorded: {
        type: Boolean,
        default: false
    },

    recordingUrl: {
        type: String
    },

    // Timestamps
    createdAt: {
        type: Date,
        default: Date.now
    },

    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true,
    indexes: [
        { callSid: 1 },
        { workflowId: 1 },
        { startTime: -1 },
        { status: 1 },
        { createdAt: -1 }
    ]
});

// Methods
ExecutionLogSchema.methods.recordNodeVisit = function (nodeId, nodeType, userInput = null) {
    this.visitedNodes.push({
        nodeId,
        nodeType,
        timestamp: new Date(),
        userInput,
        duration: 0
    });
    this.nodeExecutionCount += 1;
    return this.save();
};

ExecutionLogSchema.methods.recordUserInput = function (nodeId, input) {
    this.userInputs.push({
        nodeId,
        input,
        timestamp: new Date()
    });
    return this.save();
};

ExecutionLogSchema.methods.complete = function (reason = 'normal') {
    this.endTime = new Date();
    this.duration = this.endTime - this.startTime;
    this.status = 'completed';
    this.reason = reason;
    return this.save();
};

ExecutionLogSchema.methods.fail = function (errorMessage) {
    this.endTime = new Date();
    this.duration = this.endTime - this.startTime;
    this.status = 'failed';
    this.reason = 'error';
    this.errorMessage = errorMessage;
    return this.save();
};

ExecutionLogSchema.methods.timeout = function () {
    this.endTime = new Date();
    this.duration = this.endTime - this.startTime;
    this.status = 'timeout';
    this.reason = 'timeout';
    return this.save();
};

// Static methods
ExecutionLogSchema.statics.findByCallSid = function (callSid) {
    return this.findOne({ callSid }).sort({ createdAt: -1 });
};

ExecutionLogSchema.statics.findByWorkflow = function (workflowId, limit = 100) {
    return this.find({ workflowId })
        .sort({ createdAt: -1 })
        .limit(limit);
};

ExecutionLogSchema.statics.getActiveExecutions = function () {
    return this.find({ status: 'running' });
};

ExecutionLogSchema.statics.getAnalytics = async function (workflowId, startDate, endDate) {
    const query = { workflowId };
    if (startDate || endDate) {
        query.startTime = {};
        if (startDate) query.startTime.$gte = new Date(startDate);
        if (endDate) query.startTime.$lte = new Date(endDate);
    }

    const executions = await this.find(query);

    return {
        totalExecutions: executions.length,
        completedExecutions: executions.filter(e => e.status === 'completed').length,
        failedExecutions: executions.filter(e => e.status === 'failed').length,
        timeoutExecutions: executions.filter(e => e.status === 'timeout').length,
        averageDuration: executions.reduce((sum, e) => sum + (e.duration || 0), 0) / executions.length,
        averageNodesExecuted: executions.reduce((sum, e) => sum + e.nodeExecutionCount, 0) / executions.length,
        transferRate: executions.filter(e => e.transferAttempted).length / executions.length,
        voicemailRate: executions.filter(e => e.voicemailRecorded).length / executions.length
    };
};

// Cleanup old logs (call this periodically)
ExecutionLogSchema.statics.cleanupOldLogs = function (daysToKeep = 90) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    return this.deleteMany({
        createdAt: { $lt: cutoffDate },
        status: { $in: ['completed', 'failed', 'timeout', 'abandoned'] }
    });
};

// Pre-save middleware
ExecutionLogSchema.pre('save', function (next) {
    this.updatedAt = new Date();

    // Calculate duration if endTime is set
    if (this.endTime && this.startTime) {
        this.duration = this.endTime - this.startTime;
    }

    next();
});

const ExecutionLog = mongoose.model('ExecutionLog', ExecutionLogSchema);

export default ExecutionLog;
