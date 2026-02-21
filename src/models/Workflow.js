import mongoose from 'mongoose';

const WorkflowSchema = new mongoose.Schema({
  // System identifier (required, unique for API calls and routing)
  promptKey: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true,
    description: 'Internal system ID (e.g., "main_menu", "customer_support")'
  },

  // Human-readable name for UI
  displayName: {
    type: String,
    required: true,
    trim: true,
    description: 'What user sees in UI (e.g., "Main Menu", "Customer Support")'
  },

  // Workflow nodes (greeting, input, transfer, etc.)
  nodes: {
    type: Array,
    default: [],
    description: 'IVR workflow nodes with positions and data'
  },

  // Workflow edges (connections between nodes)
  edges: {
    type: Array,
    default: [],
    description: 'Connections between workflow nodes'
  },

  // IVR configuration
  config: {
    voiceId: {
      type: String,
      default: 'en-GB-SoniaNeural'
    },
    language: {
      type: String,
      default: 'en-GB'
    },
    provider: {
      type: String,
      default: 'edge'
    },
    timeout: {
      type: Number,
      default: 10
    },
    maxAttempts: {
      type: Number,
      default: 3
    },
    invalidInputMessage: {
      type: String,
      default: 'Invalid selection. Please try again.'
    }
  },

  // Status and lifecycle
  isActive: {
    type: Boolean,
    default: true,
    index: true,
    description: 'Soft delete control'
  },

  status: {
    type: String,
    enum: ['draft', 'active', 'inactive', 'archived'],
    default: 'draft',
    index: true
  },

  // TTS Generation Status
  ttsStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'completed',
    index: true
  },

  // Version control for enterprise pattern
  version: {
    type: Number,
    default: 1,
    min: 1
  },

  // Metadata
  tags: [{
    type: String,
    trim: true
  }],

  // Audit fields
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },

  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  }

}, {
  timestamps: true,
  // Enable optimistic concurrency control
  optimisticConcurrency: true
});

// Compound indexes for common queries
WorkflowSchema.index({ promptKey: 1, isActive: 1 });
WorkflowSchema.index({ status: 1, isActive: 1 });
WorkflowSchema.index({ createdBy: 1, isActive: 1 });
WorkflowSchema.index({ tags: 1, isActive: 1 });

// Static methods for common operations
WorkflowSchema.statics.findActive = function (filter = {}) {
  return this.find({
    isActive: true,
    ...filter
  });
};

WorkflowSchema.statics.findByPromptKey = function (promptKey) {
  return this.findOne({
    promptKey,
    isActive: true
  });
};

WorkflowSchema.statics.findWithNodes = function (filter = {}) {
  return this.find({
    isActive: true,
    nodes: { $exists: true, $not: { $size: 0 } },
    ...filter
  });
};

// Instance methods
WorkflowSchema.methods.deactivate = function () {
  this.isActive = false;
  this.status = 'archived';
  return this.save();
};

WorkflowSchema.methods.activate = function () {
  this.isActive = true;
  this.status = 'active';
  return this.save();
};

WorkflowSchema.methods.duplicate = function (newPromptKey, newDisplayName) {
  const duplicate = new this({
    promptKey: newPromptKey,
    displayName: newDisplayName,
    nodes: this.nodes,
    edges: this.edges,
    config: { ...this.config },
    tags: [...this.tags],
    status: 'draft'
  });
  return duplicate.save();
};

// Pre-save middleware
WorkflowSchema.pre('save', function (next) {
  // Only validate entry node requirement when activating the workflow
  // Allow draft workflows to be saved without entry nodes for flexibility
  if (this.isModified('status') && this.status === 'active' && this.nodes.length > 0) {
    // Auto-validate workflow structure when activating
    // Supporting both legacy 'greeting' and new 'audio' node types
    const hasEntryNode = this.nodes.some(node => node.type === 'greeting' || node.type === 'audio');

    if (!hasEntryNode) {
      const nextErr = new Error('Workflow must have at least one greeting or audio node to be activated');
      return next(nextErr);
    }
  }
  
  // Log node modifications for debugging
  if (this.isModified('nodes')) {
    const entryNodes = this.nodes.filter(node => node.type === 'greeting' || node.type === 'audio');
    console.log(`📝 Workflow ${this.promptKey} nodes modified: ${this.nodes.length} total, ${entryNodes.length} entry nodes`);
  }
  
  next();
});


// Post-save middleware for logging
WorkflowSchema.post('save', function (doc) {
  if (process.env.NODE_ENV !== 'test') {
    console.log(`🔄 Workflow ${doc.promptKey} ${doc.isNew ? 'created' : 'updated'}`);
  }
});

// Virtual for computed fields
WorkflowSchema.virtual('nodeCount').get(function () {
  return this.nodes ? this.nodes.length : 0;
});

WorkflowSchema.virtual('edgeCount').get(function () {
  return this.edges ? this.edges.length : 0;
});

WorkflowSchema.virtual('isComplete').get(function () {
  return this.nodes.length > 0 && this.edges.length > 0;
});

// Ensure virtuals are included in JSON
WorkflowSchema.set('toJSON', { virtuals: true });
WorkflowSchema.set('toObject', { virtuals: true });

const Workflow = mongoose.model('Workflow', WorkflowSchema);

export default Workflow;
