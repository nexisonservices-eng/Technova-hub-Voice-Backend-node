import mongoose from 'mongoose';

/**
 * Workflow Execution Model
 * Tracks workflow execution state, node visits, and call data
 */

const WorkflowExecutionSchema = new mongoose.Schema({
  // Call identification
  callSid: {
    type: String,
    required: true,
    unique: true,
    index: true,
    description: 'Twilio Call SID'
  },
  
  // Workflow information
  workflowId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workflow',
    required: true,
    description: 'Reference to workflow configuration'
  },
  workflowName: {
    type: String,
    required: true,
    description: 'Human-readable workflow name'
  },
  
  // Call details
  callerNumber: {
    type: String,
    required: true,
    description: 'Caller phone number in E.164 format'
  },
  destinationNumber: {
    type: String,
    required: true,
    description: 'Called phone number'
  },
  
  // Execution tracking
  status: {
    type: String,
    enum: ['pending', 'running', 'completed', 'failed', 'timeout', 'cancelled'],
    default: 'pending',
    index: true
  },
  
  // Timing
  startTime: {
    type: Date,
    required: true,
    default: Date.now
  },
  endTime: {
    type: Date,
    description: 'When the workflow ended'
  },
  duration: {
    type: Number,
    description: 'Duration in milliseconds'
  },
  
  // Current state
  currentNodeId: {
    type: String,
    description: 'Currently executing node ID'
  },
  visitedNodes: [{
    nodeId: {
      type: String,
      required: true
    },
    nodeType: {
      type: String,
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    userInput: {
      type: String,
      description: 'User input that led to this node'
    },
    duration: {
      type: Number,
      description: 'Time spent in this node (ms)'
    },
    success: {
      type: Boolean,
      default: true
    },
    error: {
      type: String,
      description: 'Error message if node failed'
    }
  }],
  
  // Variables and context
  variables: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
    description: 'Workflow variables and context data'
  },
  
  // User inputs tracking
  userInputs: [{
    nodeId: {
      type: String,
      required: true
    },
    input: {
      type: String,
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    processed: {
      type: Boolean,
      default: false
    }
  }],
  
  // Statistics
  nodeExecutionCount: {
    type: Number,
    default: 0,
    description: 'Total number of nodes executed'
  },
  loopIterations: {
    type: Number,
    default: 0,
    description: 'Number of loop iterations detected'
  },
  
  // End reasons
  endReason: {
    type: String,
    enum: ['normal', 'user_hangup', 'timeout', 'error', 'transfer', 'voicemail'],
    description: 'Why the workflow ended'
  },
  errorMessage: {
    type: String,
    description: 'Error message if workflow failed'
  },
  
  // Twilio integration
  twilioData: {
    callStatus: {
      type: String,
      enum: ['queued', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'canceled', 'failed'],
      description: 'Current Twilio call status'
    },
    callDirection: {
      type: String,
      enum: ['inbound', 'outbound'],
      default: 'inbound'
    },
    fromCountry: {
      type: String,
      description: 'Caller country code'
    },
    fromState: {
      type: String,
      description: 'Caller state/province'
    },
    fromCity: {
      type: String,
      description: 'Caller city'
    },
    answeredBy: {
      type: String,
      enum: ['human', 'machine', 'unknown'],
      description: 'Who answered the call (if detectable)'
    }
  },
  
  // Recording and transcription
  recordings: [{
    recordingUrl: {
      type: String,
      description: 'Twilio recording URL'
    },
    recordingSid: {
      type: String,
      description: 'Twilio recording SID'
    },
    duration: {
      type: Number,
      description: 'Recording duration in seconds'
    },
    transcription: {
      type: String,
      description: 'Transcribed text'
    },
    transcriptionStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending'
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  
  // AI interactions
  aiInteractions: [{
    nodeId: {
      type: String,
      required: true
    },
    userInput: {
      type: String,
      description: 'User speech/text input'
    },
    aiResponse: {
      type: String,
      description: 'AI response text'
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      description: 'AI confidence score'
    },
    processingTime: {
      type: Number,
      description: 'AI processing time in ms'
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Transfer information
  transferInfo: {
    transferredTo: {
      type: String,
      description: 'Number transferred to'
    },
    transferStatus: {
      type: String,
      enum: ['initiated', 'completed', 'failed', 'rejected'],
      description: 'Transfer outcome'
    },
    transferDuration: {
      type: Number,
      description: 'Transfer duration in seconds'
    },
    timestamp: {
      type: Date,
      description: 'When transfer was initiated'
    }
  },
  
  // Voicemail information
  voicemailInfo: {
    voicemailLeft: {
      type: Boolean,
      default: false
    },
    voicemailUrl: {
      type: String,
      description: 'Voicemail recording URL'
    },
    voicemailSid: {
      type: String,
      description: 'Voicemail recording SID'
    },
    transcription: {
      type: String,
      description: 'Voicemail transcription'
    },
    duration: {
      type: Number,
      description: 'Voicemail duration in seconds'
    },
    timestamp: {
      type: Date,
      description: 'When voicemail was left'
    }
  },
  
  // Quality metrics
  qualityMetrics: {
    totalInputTime: {
      type: Number,
      default: 0,
      description: 'Total time user spent providing input (ms)'
    },
    totalSilenceTime: {
      type: Number,
      default: 0,
      description: 'Total silence time during call (ms)'
    },
    inputAccuracy: {
      type: Number,
      min: 0,
      max: 1,
      description: 'Accuracy of user input recognition'
    },
    systemResponsiveness: {
      type: Number,
      min: 0,
      max: 1,
      description: 'How responsive the system was'
    }
  },
  
  // Metadata
  metadata: {
    userAgent: {
      type: String,
      description: 'Client user agent if applicable'
    },
    ipAddress: {
      type: String,
      description: 'Caller IP address'
    },
    sessionId: {
      type: String,
      description: 'Session identifier'
    },
    tags: [{
      type: String,
      description: 'Tags for categorization'
    }]
  }
}, {
  timestamps: true,
  // Indexes for performance
  indexes: [
    { callSid: 1 },
    { status: 1 },
    { startTime: -1 },
    { callerNumber: 1 },
    { workflowId: 1 },
    { 'twilioData.callStatus': 1 },
    { endTime: -1 },
    { duration: -1 }
  ]
});

// Instance methods
WorkflowExecutionSchema.methods.recordNodeVisit = function(nodeId, nodeType, userInput = null, duration = 0, success = true, error = null) {
  this.visitedNodes.push({
    nodeId,
    nodeType,
    userInput,
    duration,
    success,
    error,
    timestamp: new Date()
  });
  
  this.currentNodeId = nodeId;
  this.nodeExecutionCount += 1;
  
  return this.save();
};

WorkflowExecutionSchema.methods.recordUserInput = function(nodeId, input) {
  this.userInputs.push({
    nodeId,
    input,
    timestamp: new Date()
  });
  
  // Store in variables for easy access
  this.variables[`last_input_${nodeId}`] = input;
  this.variables.caller_input = input;
  
  return this.save();
};

WorkflowExecutionSchema.methods.setVariable = function(key, value) {
  this.variables[key] = value;
  return this.save();
};

WorkflowExecutionSchema.methods.getVariable = function(key) {
  return this.variables[key];
};

WorkflowExecutionSchema.methods.recordAIInteraction = function(nodeId, userInput, aiResponse, confidence = null, processingTime = 0) {
  this.aiInteractions.push({
    nodeId,
    userInput,
    aiResponse,
    confidence,
    processingTime,
    timestamp: new Date()
  });
  
  return this.save();
};

WorkflowExecutionSchema.methods.recordRecording = function(recordingUrl, recordingSid, duration = 0) {
  this.recordings.push({
    recordingUrl,
    recordingSid,
    duration,
    timestamp: new Date()
  });
  
  return this.save();
};

WorkflowExecutionSchema.methods.updateTranscription = function(recordingSid, transcription) {
  const recording = this.recordings.find(r => r.recordingSid === recordingSid);
  if (recording) {
    recording.transcription = transcription;
    recording.transcriptionStatus = 'completed';
  }
  
  return this.save();
};

WorkflowExecutionSchema.methods.recordTransfer = function(transferredTo, status = 'initiated') {
  this.transferInfo = {
    transferredTo,
    transferStatus: status,
    timestamp: new Date()
  };
  
  return this.save();
};

WorkflowExecutionSchema.methods.recordVoicemail = function(voicemailUrl, voicemailSid, transcription = null, duration = 0) {
  this.voicemailInfo = {
    voicemailLeft: true,
    voicemailUrl,
    voicemailSid,
    transcription,
    duration,
    timestamp: new Date()
  };
  
  return this.save();
};

WorkflowExecutionSchema.methods.updateTwilioStatus = function(callStatus, additionalData = {}) {
  this.twilioData.callStatus = callStatus;
  
  // Update additional Twilio data
  Object.assign(this.twilioData, additionalData);
  
  // Update workflow status based on call status
  if (['completed', 'busy', 'no-answer', 'canceled', 'failed'].includes(callStatus)) {
    this.status = 'completed';
    this.endTime = new Date();
    this.duration = this.endTime - this.startTime;
    this.endReason = this.mapCallStatusToEndReason(callStatus);
  }
  
  return this.save();
};

WorkflowExecutionSchema.methods.mapCallStatusToEndReason = function(callStatus) {
  const mapping = {
    'completed': 'normal',
    'busy': 'transfer',
    'no-answer': 'timeout',
    'canceled': 'user_hangup',
    'failed': 'error'
  };
  
  return mapping[callStatus] || 'normal';
};

WorkflowExecutionSchema.methods.endExecution = function(reason = 'normal', errorMessage = null) {
  this.status = reason === 'error' ? 'failed' : 'completed';
  this.endTime = new Date();
  this.duration = this.endTime - this.startTime;
  this.endReason = reason;
  
  if (errorMessage) {
    this.errorMessage = errorMessage;
  }
  
  this.currentNodeId = null;
  
  return this.save();
};

// Static methods
WorkflowExecutionSchema.statics.getActiveExecutions = function() {
  return this.find({ 
    status: { $in: ['pending', 'running'] },
    startTime: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // Last 30 minutes
  });
};

WorkflowExecutionSchema.statics.getExecutionsByCaller = function(callerNumber, limit = 10) {
  return this.find({ callerNumber })
    .sort({ startTime: -1 })
    .limit(limit);
};

WorkflowExecutionSchema.statics.getWorkflowStatistics = function(workflowId, startDate = null, endDate = null) {
  const matchQuery = { workflowId };
  
  if (startDate || endDate) {
    matchQuery.startTime = {};
    if (startDate) matchQuery.startTime.$gte = startDate;
    if (endDate) matchQuery.startTime.$lte = endDate;
  }
  
  return this.aggregate([
    { $match: matchQuery },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgDuration: { $avg: '$duration' },
        totalDuration: { $sum: '$duration' }
      }
    }
  ]);
};

WorkflowExecutionSchema.statics.getPopularNodes = function(workflowId = null, limit = 10) {
  const matchQuery = {};
  if (workflowId) matchQuery.workflowId = workflowId;
  
  return this.aggregate([
    { $match: matchQuery },
    { $unwind: '$visitedNodes' },
    {
      $group: {
        _id: '$visitedNodes.nodeId',
        nodeType: { $first: '$visitedNodes.nodeType' },
        visitCount: { $sum: 1 },
        avgDuration: { $avg: '$visitedNodes.duration' },
        successRate: {
          $avg: { $cond: ['$visitedNodes.success', 1, 0] }
        }
      }
    },
    { $sort: { visitCount: -1 } },
    { $limit: limit }
  ]);
};

// Pre-save middleware
WorkflowExecutionSchema.pre('save', function(next) {
  // Update duration if endTime is set
  if (this.endTime && this.startTime) {
    this.duration = this.endTime - this.startTime;
  }
  
  next();
});

const WorkflowExecution = mongoose.model('WorkflowExecution', WorkflowExecutionSchema);

export default WorkflowExecution;
