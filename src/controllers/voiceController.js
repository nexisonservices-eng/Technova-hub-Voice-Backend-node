// controllers/callController.js
import telephonyService from '../services/telephonyService.js';
import callStateService from '../services/callStateService.js';
import logger from '../utils/logger.js';
import Call from "../models/call.js";

class CallController {
  /**
   * 📤 Start an outbound call (JWT-protected)
   */
  async startOutboundCall(req, res) {
    try {
      const { phoneNumber, scenario } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ message: "Phone number is required" });
      }

      const result = await telephonyService.initiateOutboundCall(phoneNumber, scenario);

      await callStateService.createCall({
        callSid: result.callSid,
        phoneNumber,
        direction: 'outbound',
        provider: telephonyService.provider,
        scenario: scenario || null
      });

      res.status(200).json({
        success: true,
        message: "Outbound call initiated",
        data: result
      });
    } catch (error) {
      logger.error('Outbound call error:', error);
      res.status(500).json({ message: "Outbound call failed", error: error.message });
    }
  }

  /**
   * 📥 Handle inbound call webhook (LEGACY - for backward compatibility)
   * New enhanced inbound calls are handled by InboundCallController
   */
  async handleInboundCall(req, res) {
    try {
      const { CallSid, From } = req.body;

      if (!CallSid || !From) {
        return res.status(400).send('Invalid inbound call data');
      }

      logger.info(`📞 Legacy inbound call: ${CallSid} from ${From}`);

      await callStateService.createCall({
        callSid: CallSid,
        phoneNumber: From,
        direction: 'inbound',
        provider: telephonyService.provider
      });

      const websocketUrl = `wss://${req.get('host')}/media/${CallSid}`;

      const twiml = telephonyService.generateIncomingTwiML(
        websocketUrl,
        'Hello! Connecting you to our AI assistant.'
      );

      res.type('text/xml');
      res.send(twiml);
    } catch (error) {
      logger.error('Inbound call error:', error);
      const twiml = `<Response><Say>Sorry, there was an error processing your call.</Say></Response>`;
      res.type('text/xml').status(500).send(twiml);
    }
  }

  /**
   * 📄 Get call details by CallSid
   */
  async getCallDetails(req, res) {
    try {
      const { callSid } = req.params;
      const call = await Call.findOne({ callSid }).populate('user');

      if (!call) {
        return res.status(404).json({ error: 'Call not found' });
      }

      res.json(call);
    } catch (error) {
      logger.error('Get call details error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 📋 Get all active calls
   */
  async getActiveCalls(req, res) {
    try {
      const activeCalls = await Call.find({
        status: { $in: ['initiated', 'ringing', 'in-progress'] }
      })
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .limit(100);

      res.json({
        success: true,
        count: activeCalls.length,
        calls: activeCalls
      });
    } catch (error) {
      logger.error('Get active calls error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 📊 Get call statistics
   */
  async getCallStats(req, res) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const calls = await Call.find({
        createdAt: { $gte: today }
      });

      const totalCalls = calls.length;
      const completedCalls = calls.filter(c => c.status === 'completed');
      const avgDuration = completedCalls.length > 0
        ? Math.round(completedCalls.reduce((sum, c) => sum + (c.duration || 0), 0) / completedCalls.length)
        : 0;
      const successRate = totalCalls > 0
        ? Math.round((completedCalls.length / totalCalls) * 100)
        : 0;

      res.json({
        success: true,
        totalCalls,
        avgDuration,
        successRate,
        breakdown: {
          completed: completedCalls.length,
          inProgress: calls.filter(c => ['initiated', 'ringing', 'in-progress'].includes(c.status)).length,
          failed: calls.filter(c => c.status === 'failed').length,
        }
      });
    } catch (error) {
      logger.error('Get call stats error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

export default new CallController();
