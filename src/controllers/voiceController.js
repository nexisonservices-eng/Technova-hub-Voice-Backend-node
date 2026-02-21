// controllers/voiceController.js
import telephonyService from '../services/telephonyService.js';
import callStateService from '../services/callStateService.js';
import logger from '../utils/logger.js';
import Call from '../models/call.js';

class CallController {
  async startOutboundCall(req, res) {
    try {
      const { phoneNumber, scenario } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ message: 'Phone number is required' });
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
        message: 'Outbound call initiated',
        data: result
      });
    } catch (error) {
      logger.error('Outbound call error:', error);
      res.status(500).json({ message: 'Outbound call failed', error: error.message });
    }
  }

  async handleInboundCall(req, res) {
    try {
      res.type('text/xml');
      res.send(`
        <Response>
          <Say voice="alice">Your call has been received. Please hold.</Say>
        </Response>
      `);
    } catch (error) {
      logger.error('Inbound call error:', error);
      res.status(500).send('Inbound call failed');
    }
  }

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

  async getCallStats(req, res) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const calls = await Call.find({ createdAt: { $gte: today } });

      const completed = calls.filter(c => c.status === 'completed');

      res.json({
        success: true,
        totalCalls: calls.length,
        avgDuration: completed.length
          ? Math.round(completed.reduce((s, c) => s + (c.duration || 0), 0) / completed.length)
          : 0,
        successRate: calls.length
          ? Math.round((completed.length / calls.length) * 100)
          : 0
      });
    } catch (error) {
      logger.error('Get call stats error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async endCall(req, res) {
    try {
      const { callSid } = req.params;

      if (!callSid) {
        return res.status(400).json({ success: false, message: 'Call SID is required' });
      }

      await telephonyService.endCall(callSid);
      await callStateService.endCall(callSid);

      await Call.updateOne(
        { callSid },
        { $set: { status: 'completed', endTime: new Date() } }
      );

      res.json({
        success: true,
        message: 'Call ended successfully',
        data: { callSid }
      });
    } catch (error) {
      logger.error('End call error:', error);
      res.status(500).json({ success: false, message: 'Failed to end call', error: error.message });
    }
  }
}

export default new CallController();
