/**
 * Clean Workflow Node Service
 * Extends existing Workflow execution engine with database tracking and validation
 * No duplicate logic - uses existing systems
 */

import { NODE_CONFIGS, VALIDATION_RULES } from '../config/workflowNodeConfig.js';
import logger from '../utils/logger.js';
import Workflow from '../models/Workflow.js';
import WorkflowExecution from '../models/WorkflowExecution.js';
import WorkflowExecutionEngine from './ivrExecutionEngine.js';
import ivrWorkflowEngine from './ivrWorkflowEngine.js';

class WorkflowNodeService {
  constructor() {
    // Use existing execution engine instead of duplicating handlers
    this.existingEngine = WorkflowExecutionEngine;
    this.workflowEngine = ivrWorkflowEngine;
  }

  /**
   * Execute node using existing Workflow execution engine with database tracking
   */
  async executeNode(node, context, workflowConfig) {
    try {
      logger.info(`Executing node: ${node.type} (${node.id}) using existing engine`);
      
      // Get execution record if callSid provided
      let execution = null;
      if (context.callSid) {
        execution = await WorkflowExecution.findOne({ callSid: context.callSid });
      }
      
      const startTime = Date.now();
      
      // Use existing Workflow execution engine
      const twiml = await this.existingEngine.executeNode(node, context, workflowConfig, context.callSid);
      const duration = Date.now() - startTime;
      
      // Record execution in database (enhanced tracking)
      if (execution) {
        await execution.recordNodeVisit(
          node.id, 
          node.type, 
          context.userInput, 
          duration, 
          true, // success
          null  // no error
        );
        
        // Record user input if provided
        if (context.userInput) {
          await execution.recordUserInput(node.id, context.userInput);
        }
      }
      
      return {
        success: true,
        twiml,
        duration,
        executionId: execution?._id
      };
    } catch (error) {
      logger.error(`Error executing node ${node.id}:`, error);
      
      // Record error in database
      if (context.callSid) {
        const execution = await WorkflowExecution.findOne({ callSid: context.callSid });
        if (execution) {
          await execution.recordNodeVisit(node.id, node.type, context.userInput, 0, false, error.message);
        }
      }
      
      throw error;
    }
  }

  /**
   * Validate node configuration
   */
  validateNode(nodeType, nodeData) {
    const config = NODE_CONFIGS[nodeType];
    if (!config) {
      throw new Error(`Unknown node type: ${nodeType}`);
    }

    const errors = [];
    const warnings = [];

    // Check required fields
    if (config.validation?.required) {
      for (const field of config.validation.required) {
        if (!nodeData[field]) {
          errors.push(`Required field '${field}' is missing`);
        }
      }
    }

    // Apply validation rules
    if (config.validation?.rules) {
      for (const [field, rules] of Object.entries(config.validation.rules)) {
        const value = nodeData[field];
        
        if (value !== undefined && value !== null) {
          // Type validation
          if (rules.type && typeof value !== rules.type) {
            errors.push(`Field '${field}' must be of type ${rules.type}`);
          }

          // String validations
          if (typeof value === 'string') {
            if (rules.minLength && value.length < rules.minLength) {
              errors.push(`Field '${field}' must be at least ${rules.minLength} characters`);
            }
            if (rules.maxLength && value.length > rules.maxLength) {
              errors.push(`Field '${field}' must not exceed ${rules.maxLength} characters`);
            }
            if (rules.pattern && !new RegExp(rules.pattern).test(value)) {
              errors.push(`Field '${field}' format is invalid`);
            }
          }

          // Number validations
          if (typeof value === 'number') {
            if (rules.min !== undefined && value < rules.min) {
              errors.push(`Field '${field}' must be at least ${rules.min}`);
            }
            if (rules.max !== undefined && value > rules.max) {
              errors.push(`Field '${field}' must not exceed ${rules.max}`);
            }
          }
        }
      }
    }

    // Node-specific validations
    this.validateNodeSpecific(nodeType, nodeData, errors, warnings);

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Node-specific validations
   */
  validateNodeSpecific(nodeType, nodeData, errors, warnings) {
    switch (nodeType) {
      case 'transfer':
        if (nodeData.destination && !VALIDATION_RULES.phoneNumber.pattern.test(nodeData.destination)) {
          errors.push('Destination must be a valid phone number');
        }
        break;

      case 'voicemail':
        if (nodeData.emailNotifications) {
          for (const notification of nodeData.emailNotifications) {
            if (notification.email && !VALIDATION_RULES.email.pattern.test(notification.email)) {
              errors.push(`Invalid email address: ${notification.email}`);
            }
          }
        }
        break;

      case 'ai_assistant':
        if (nodeData.streamUrl && !VALIDATION_RULES.webhookUrl.pattern.test(nodeData.streamUrl)) {
          errors.push('Stream URL must be a valid HTTP/HTTPS URL');
        }
        break;

      case 'api_call':
        if (nodeData.url && !VALIDATION_RULES.url.pattern.test(nodeData.url)) {
          errors.push('API URL must be a valid HTTP/HTTPS URL');
        }
        break;
    }
  }

  /**
   * Get node configuration schema (uses existing config)
   */
  getNodeSchema(nodeType) {
    const config = NODE_CONFIGS[nodeType];
    if (!config) {
      throw new Error(`Unknown node type: ${nodeType}`);
    }

    return {
      type: nodeType,
      name: config.name,
      category: config.category,
      icon: config.icon,
      description: config.description,
      color: config.color,
      inputs: config.inputs,
      outputs: config.outputs,
      dataSchema: config.dataSchema,
      validation: config.validation
    };
  }

  /**
   * Get all available node types
   */
  getAllNodeTypes() {
    return Object.keys(NODE_CONFIGS).map(type => this.getNodeSchema(type));
  }

  /**
   * Create a new node (uses existing workflow engine)
   */
  createNode(nodeType, position, initialData = {}) {
    const config = NODE_CONFIGS[nodeType];
    if (!config) {
      throw new Error(`Unknown node type: ${nodeType}`);
    }

    // Generate unique node ID
    const nodeId = this.generateNodeId(nodeType);

    // Merge default data with provided data
    const nodeData = {
      ...this.getDefaultNodeData(nodeType),
      ...initialData
    };

    // Validate the node
    const validation = this.validateNode(nodeType, nodeData);
    if (!validation.isValid) {
      throw new Error(`Invalid node configuration: ${validation.errors.join(', ')}`);
    }

    return {
      id: nodeId,
      type: nodeType,
      position: position || { x: 0, y: 0 },
      data: nodeData
    };
  }

  /**
   * Generate unique node ID
   */
  generateNodeId(nodeType) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 5);
    return `${nodeType}_${timestamp}_${random}`;
  }

  /**
   * Get default data for a node type
   */
  getDefaultNodeData(nodeType) {
    const config = NODE_CONFIGS[nodeType];
    if (!config) return {};

    const defaults = {};
    if (config.dataSchema) {
      for (const [key, schema] of Object.entries(config.dataSchema)) {
        if (schema.default !== undefined) {
          defaults[key] = schema.default;
        }
      }
    }

    return defaults;
  }

  /**
   * Get execution statistics using existing workflow engine
   */
  async getExecutionStatistics() {
    try {
      const activeExecutions = this.workflowEngine.activeExecutions.size;
      const totalExecutions = await WorkflowExecution.countDocuments();
      const recentExecutions = await WorkflowExecution
        .find({ startTime: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } })
        .countDocuments();

      return {
        activeExecutions,
        totalExecutions,
        recentExecutions,
        engineStatus: 'active'
      };
    } catch (error) {
      logger.error('Error getting execution statistics:', error);
      throw error;
    }
  }

  /**
   * Test node execution (for testing purposes only)
   */
  async testNodeExecution(nodeType, nodeData, context = {}) {
    try {
      // Create test node
      const node = this.createNode(nodeType, { x: 0, y: 0 }, nodeData);
      
      // Create test workflow config
      const workflowConfig = {
        _id: 'test_workflow',
        settings: {
          voice: 'alice',
          language: 'en-GB',
          timeout: 10
        },
        nodes: [node],
        edges: []
      };

      // Execute node
      const result = await this.executeNode(node, context, workflowConfig);
      
      return {
        success: true,
        result,
        node: node
      };
    } catch (error) {
      logger.error(`Test execution failed for ${nodeType}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Cleanup test data (for testing purposes only)
   */
  async cleanupTestData() {
    try {
      // Clean up test executions
      await WorkflowExecution.deleteMany({ 
        workflowId: 'test_workflow',
        workflowName: { $regex: /test/i }
      });
      
      logger.info('Test data cleaned up');
      return { success: true };
    } catch (error) {
      logger.error('Error cleaning up test data:', error);
      return { success: false, error: error.message };
    }
  }
}

export default new WorkflowNodeService();
