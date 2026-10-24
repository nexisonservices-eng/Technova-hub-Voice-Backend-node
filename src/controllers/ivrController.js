import twilio from "twilio";
import pythonTTSService from "../services/pythonTTSService.js";
import Workflow from "../models/Workflow.js";
import logger from "../utils/logger.js";
import TwiMLHelper from "../utils/twimlHelper.js";
import ivrWorkflowEngine from "../services/ivrWorkflowEngine.js";
import ExecutionLog from "../models/ExecutionLog.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

class IVRController {
  constructor() {
    this.supportedLanguages = pythonTTSService.getSupportedLanguages();

    // Bind methods to preserve `this` 
    this.welcome = this.welcome.bind(this);
    this.selectLanguage = this.selectLanguage.bind(this);
    this.handleInput = this.handleInput.bind(this);
    this.nextStep = this.nextStep.bind(this);
  }

  /* =========================
     HELPERS
  ========================== */

  send(res, twiml) {
    res.type("text/xml");
    res.send(twiml);
  }

  isValidWorkflowId(value) {
    return /^[a-f\d]{24}$/i.test(String(value || '').trim());
  }

  /**
   * Fetch the active IVR workflow
   */
  async getActiveWorkflow(userId = null) {
    const ownerId = String(userId || '').trim();
    // Twilio callbacks can be authenticated with the shared account token
    // even when the phone number has no tenant profile. Do not pass sentinels
    // such as "undefined" into Mongoose's ObjectId query casting.
    if (!/^[a-f\d]{24}$/i.test(ownerId)) {
      return null;
    }

    const filter = { status: 'active', isActive: true };
    if (Workflow.schema.path('createdBy')) {
      filter.createdBy = ownerId;
    }
    return await Workflow.findOne(filter);
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
      const workflow = await this.getActiveWorkflow(req.tenantContext?.adminId || null);

      if (!workflow) {
        logger.warn('No active IVR workflow found. Falling back to default welcome.');
        return this.sendDefaultWelcome(res);
      }

      // Start from the first node (usually greeting/audio)
      const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
      const startNode = nodes.find((node) => node.type === 'greeting' || node.type === 'audio') || nodes[0];
      if (!startNode) throw new Error('Workflow has no nodes');

      // Initialize execution tracking
      await ivrWorkflowEngine.startExecution(
        workflow._id,
        CallSid,
        From,
        To,
        req.tenantContext?.adminId || workflow.createdBy || null
      );

      const twiml = await ivrWorkflowEngine.generateTwiML(workflow._id, startNode.id, null, CallSid);
      this.send(res, twiml);
    } catch (err) {
      logger.error('IVR welcome failed', {
        CallSid: CallSid || null,
        workflowId: null,
        nodeId: null,
        failureReason: 'welcome_workflow_start_failed',
        errorName: err?.name || 'Error'
      });
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
      const normalizedStatus = String(CallStatus || '').trim().toLowerCase();
      const terminalReasons = {
        completed: 'normal',
        failed: 'error',
        busy: 'error',
        'no-answer': 'error',
        canceled: 'user_hangup'
      };
      const reason = terminalReasons[normalizedStatus];
      if (reason) {
        await ivrWorkflowEngine.endExecution(CallSid, reason);
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
    const { CallSid, Digits } = { ...req.body, ...req.query };
    let { workflowId, currentNodeId } = { ...req.body, ...req.query };

    try {
      // Twilio normally returns the workflow/node IDs on the Gather action URL.
      // Recover them by CallSid if a provider/proxy strips that query string.
      if (!this.isValidWorkflowId(workflowId)) workflowId = null;
      if ((!workflowId || !currentNodeId) && CallSid) {
        const executionState = ivrWorkflowEngine.getExecutionState(CallSid);
        workflowId = workflowId || executionState?.workflowId;
        currentNodeId = currentNodeId || executionState?.currentNodeId;
        let contextSource = executionState ? 'memory' : '';
        if (!workflowId || !currentNodeId) {
          const executionLog = await ExecutionLog.findOne({ callSid: CallSid })
            .sort({ startTime: -1 })
            .select('workflowId visitedNodes')
            .lean();
          workflowId = workflowId || executionLog?.workflowId;
          currentNodeId = currentNodeId || executionLog?.visitedNodes?.at(-1)?.nodeId;
          if (executionLog) contextSource = 'execution_log';
        }

        if (workflowId && currentNodeId) {
          logger.warn('Recovered IVR input context from call execution state', {
            CallSid,
            workflowId: String(workflowId),
            currentNodeId,
            source: contextSource
          });
        }
      }

      if (!workflowId || !currentNodeId) {
        logger.error('Missing workflow context in handleInput', {
          CallSid: CallSid || null,
          workflowId: workflowId || null,
          currentNodeId: currentNodeId || null,
          failureReason: !workflowId && !currentNodeId
            ? 'workflow_id_and_node_id_missing'
            : (!workflowId ? 'workflow_id_missing' : 'current_node_id_missing'),
          callbackPath: req.path || null,
          bodyHasWorkflowId: Boolean(req.body?.workflowId),
          bodyHasCurrentNodeId: Boolean(req.body?.currentNodeId),
          queryHasWorkflowId: Boolean(req.query?.workflowId),
          queryHasCurrentNodeId: Boolean(req.query?.currentNodeId)
        });
        return this.send(res, TwiMLHelper.createErrorResponse());
      }

      const nextNodeId = await ivrWorkflowEngine.handleUserInput(workflowId, currentNodeId, Digits, CallSid);

      if (!nextNodeId) {
        logger.warn('No matching IVR path for keypad input', {
          CallSid: CallSid || null,
          workflowId: String(workflowId),
          nodeId: currentNodeId,
          failureReason: 'no_matching_input_path'
        });
        try {
          const retryTwiml = await ivrWorkflowEngine.generateTwiML(workflowId, currentNodeId, null, CallSid);
          return this.send(res, retryTwiml);
        } catch (retryErr) {
          logger.error('IVR fallback retry failed after missing next node', {
            CallSid: CallSid || null,
            workflowId: String(workflowId),
            nodeId: currentNodeId,
            failureReason: 'retry_current_node_after_no_match_failed',
            errorName: retryErr?.name || 'Error'
          });
          const twiml = TwiMLHelper.createErrorResponse("Invalid selection. Please try again.");
          return this.send(res, twiml);
        }
      }

      try {
        const twiml = await ivrWorkflowEngine.generateTwiML(workflowId, nextNodeId, Digits, CallSid);
        this.send(res, twiml);
        return;
      } catch (nextErr) {
        logger.error('Failed to generate TwiML for next IVR node; retrying current node', {
          CallSid: CallSid || null,
          workflowId: String(workflowId),
          nodeId: nextNodeId,
          failureReason: 'next_node_twiml_generation_failed',
          errorName: nextErr?.name || 'Error'
        });
        try {
          const retryTwiml = await ivrWorkflowEngine.generateTwiML(workflowId, currentNodeId, null, CallSid);
          return this.send(res, retryTwiml);
        } catch (retryErr) {
          logger.error('Failed to regenerate current IVR node after next-node failure', {
            CallSid: CallSid || null,
            workflowId: String(workflowId),
            nodeId: currentNodeId,
            failureReason: 'retry_current_node_twiml_generation_failed',
            errorName: retryErr?.name || 'Error'
          });
          const fallbackTwiml = TwiMLHelper.createGatherResponse(
            'We could not process that selection. Please try again.',
            `/ivr/handle-input?workflowId=${workflowId}&currentNodeId=${currentNodeId}`,
            {
              say: {
                voice: 'alice',
                language: 'en-US'
              },
              gather: {
                numDigits: 1,
                timeout: 10
              }
            }
          );
          return this.send(res, fallbackTwiml);
        }
      }
    } catch (err) {
      logger.error('IVR keypad input handling failed', {
        CallSid: CallSid || null,
        workflowId: workflowId ? String(workflowId) : null,
        nodeId: currentNodeId || null,
        failureReason: 'handle_input_exception',
        errorName: err?.name || 'Error'
      });
      const fallbackTwiml = TwiMLHelper.createGatherResponse(
        'We could not process that selection. Please try again.',
        `/ivr/handle-input?workflowId=${workflowId || ''}&currentNodeId=${currentNodeId || ''}`,
        {
          say: {
            voice: 'alice',
            language: 'en-US'
          },
          gather: {
            numDigits: 1,
            timeout: 10
          }
        }
      );
      this.send(res, fallbackTwiml);
    }
  }

  /**
   * Handles transitions between non-blocking nodes
   */
  async nextStep(req, res) {
    let { CallSid, workflowId, currentNodeId, status, fallbackNodeId } = { ...req.body, ...req.query };

    try {
      // Provider callback URLs can contain the literal string "undefined".
      // Treat it as missing and recover context from the call execution.
      if (!this.isValidWorkflowId(workflowId) && CallSid) {
        workflowId = null;
        const state = ivrWorkflowEngine.getExecutionState(CallSid);
        workflowId = state?.workflowId || null;
        currentNodeId = currentNodeId || state?.currentNodeId;

        if (!this.isValidWorkflowId(workflowId) || !currentNodeId) {
          const executionLog = await ExecutionLog.findOne({ callSid: CallSid })
            .sort({ startTime: -1 })
            .select('workflowId visitedNodes')
            .lean();
          workflowId = this.isValidWorkflowId(workflowId) ? workflowId : executionLog?.workflowId;
          currentNodeId = currentNodeId || executionLog?.visitedNodes?.at(-1)?.nodeId;
        }
      }

      if (!this.isValidWorkflowId(workflowId) || !currentNodeId) {
        logger.error('Missing workflow context in nextStep', {
          CallSid: CallSid || null,
          workflowId: workflowId || null,
          currentNodeId: currentNodeId || null,
          failureReason: !this.isValidWorkflowId(workflowId) ? 'workflow_id_missing_or_invalid' : 'current_node_id_missing'
        });
        return this.send(res, TwiMLHelper.createErrorResponse());
      }

      if (status) {
        const nextNodeId = await ivrWorkflowEngine.getNextNodeByHandle(workflowId, currentNodeId, status);
        if (nextNodeId) {
          const twiml = await ivrWorkflowEngine.generateTwiML(workflowId, nextNodeId, null, CallSid);
          return this.send(res, twiml);
        }
        if (fallbackNodeId) {
          const twiml = await ivrWorkflowEngine.generateTwiML(workflowId, fallbackNodeId, null, CallSid);
          return this.send(res, twiml);
        }

        const response = new VoiceResponse();
        response.say('Thank you for your message. Goodbye.');
        response.hangup();
        return this.send(res, response.toString());
      }

      const twiml = await ivrWorkflowEngine.generateTwiML(workflowId, currentNodeId, null, CallSid);
      this.send(res, twiml);
    } catch (err) {
      logger.error('IVR next-step execution failed', {
        CallSid: CallSid || null,
        workflowId: workflowId || null,
        nodeId: currentNodeId || null,
        failureReason: 'next_step_execution_failed',
        errorName: err?.name || 'Error'
      });
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
