import twilio from "twilio";
import pythonTTSService from "../services/pythonTTSService.js";
import Workflow from "../models/Workflow.js";
import logger from "../utils/logger.js";
import TwiMLHelper from "../utils/twimlHelper.js";
import ivrWorkflowEngine from "../services/ivrWorkflowEngine.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

class IVRController {
  constructor() {
    this.supportedLanguages = pythonTTSService.getSupportedLanguages();

    // Bind methods to preserve `this` 
    this.welcome = this.welcome.bind(this);
    this.selectLanguage = this.selectLanguage.bind(this);
    this.handleInput = this.handleInput.bind(this);
    this.nextStep = this.nextStep.bind(this);
    this.processService = this.processService.bind(this);
  }

  /* =========================
     HELPERS
  ========================== */

  send(res, twiml) {
    res.type("text/xml");
    res.send(twiml);
  }

  /**
   * Fetch the active IVR workflow
   */
  async getActiveWorkflow() {
    return await Workflow.findOne({ status: 'active', isActive: true });
  }

  /* =========================
     DYNAMIC WORKFLOW HANDLERS
  ========================== */

  /**
   * Initial entry point for incoming calls
   */
  /**
   * Initial entry point for incoming calls
   */
  async welcome(req, res) {
    const { CallSid, From, To } = req.body || {};
    logger.info(`Incoming call ${CallSid || "unknown"}`);

    try {
      const workflow = await this.getActiveWorkflow();

      if (!workflow) {
        logger.warn('No active IVR workflow found. Falling back to default welcome.');
        return this.sendDefaultWelcome(res);
      }

      // Start from the first node (usually greeting/audio)
      const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
      const startNode = nodes.find((node) => node.type === 'greeting' || node.type === 'audio') || nodes[0];
      if (!startNode) throw new Error('Workflow has no nodes');

      // Initialize execution tracking
      await ivrWorkflowEngine.startExecution(workflow._id, CallSid, From, To);

      const twiml = await ivrWorkflowEngine.generateTwiML(workflow._id, startNode.id, null, CallSid);
      this.send(res, twiml);
    } catch (err) {
      logger.error("Welcome error:", err);
      this.send(res, TwiMLHelper.createErrorResponse());
    }
  }

  /**
   * Handle call status updates (completed, failed, etc.)
   */
  async handleCallStatus(req, res) {
    const { CallSid, CallStatus } = req.body;
    logger.info(`Call Status Update: ${CallSid} -> ${CallStatus}`);

    try {
      if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
        await ivrWorkflowEngine.endExecution(CallSid, CallStatus);
      }
      res.sendStatus(200);
    } catch (err) {
      logger.error("Error handling call status:", err);
      res.sendStatus(500);
    }
  }

  /**
   * Handles user input (DTMF) from Gather
   */
  async handleInput(req, res) {
    const { CallSid, Digits, workflowId, currentNodeId } = { ...req.body, ...req.query };

    try {
      if (!workflowId || !currentNodeId) {
        logger.error('Missing workflow context in handleInput');
        return this.send(res, TwiMLHelper.createErrorResponse());
      }

      const nextNodeId = await ivrWorkflowEngine.handleUserInput(workflowId, currentNodeId, Digits);

      if (!nextNodeId) {
        logger.warn(`No matching path for input ${Digits} at node ${currentNodeId}`);
        // Send back to current node or error
        const twiml = TwiMLHelper.createErrorResponse("Invalid selection. Please try again.");
        return this.send(res, twiml);
      }

      const twiml = await ivrWorkflowEngine.generateTwiML(workflowId, nextNodeId, Digits, CallSid);
      this.send(res, twiml);
    } catch (err) {
      logger.error("Handle input error:", err);
      this.send(res, TwiMLHelper.createErrorResponse());
    }
  }

  /**
   * Handles transitions between non-blocking nodes
   */
  async nextStep(req, res) {
    const { CallSid, workflowId, currentNodeId, status } = { ...req.body, ...req.query };

    try {
      if (status) {
        const nextNodeId = await ivrWorkflowEngine.getNextNodeByHandle(workflowId, currentNodeId, status);
        if (nextNodeId) {
          const twiml = await ivrWorkflowEngine.generateTwiML(workflowId, nextNodeId, null, CallSid);
          return this.send(res, twiml);
        }
      }

      const twiml = await ivrWorkflowEngine.generateTwiML(workflowId, currentNodeId, null, CallSid);
      this.send(res, twiml);
    } catch (err) {
      logger.error("Next step error:", err);
      this.send(res, TwiMLHelper.createErrorResponse());
    }
  }

  /**
   * Handles industry-specific service execution
   */
  async processService(req, res) {
    const { CallSid, workflowId, nodeId } = { ...req.body, ...req.query };

    try {
      const workflow = await Workflow.findById(workflowId);
      const node = workflow.nodes.find(n => n.id === nodeId);

      const result = await ivrWorkflowEngine.processIndustryService(
        node.industry || 'custom',
        node.type,
        node.data,
        CallSid
      );

      const response = new VoiceResponse();
      const voice = workflow.config?.voice || 'alice';
      const language = workflow.config?.language || 'en-US';

      if (result.success) {
        response.say({ voice, language }, `Your request has been processed. Reference number is ${result.data.reference.split('').join(' ')}`);
        ivrWorkflowEngine.appendNextStep(response, workflow, nodeId);
      } else {
        response.say({ voice, language }, "We were unable to process your request at this time.");
        ivrWorkflowEngine.appendNextStep(response, workflow, nodeId, 'error');
      }

      this.send(res, response.toString());
    } catch (err) {
      logger.error("Process service error:", err);
      this.send(res, TwiMLHelper.createErrorResponse());
    }
  }

  /* =========================
     FALLBACK / LEGACY
  ========================== */

  sendDefaultWelcome(res) {
    const language = "en-US";
    const twiml = TwiMLHelper.createWelcomeMenu(
      "Welcome to Technovo automation.",
      "Press 1 for Sales. Press 2 for Support.",
      "/ivr/handle-input"
    );
    this.send(res, twiml);
  }

  // Keeping these for potential migration or testing
  async selectLanguage(req, res) {
    // Legacy selection logic...
    this.send(res, TwiMLHelper.createErrorResponse("This endpoint is deprecated. Using dynamic workflow instead."));
  }
}

export default IVRController;
