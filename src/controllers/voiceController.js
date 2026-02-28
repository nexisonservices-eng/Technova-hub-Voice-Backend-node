// controllers/voiceController.js
import telephonyService from '../services/telephonyService.js';
import callStateService from '../services/callStateService.js';
import logger from '../utils/logger.js';
import Call from '../models/call.js';
import BroadcastCall from '../models/BroadcastCall.js';
import { getUserIdString } from '../utils/authContext.js';

class CallController {
  async startOutboundCall(req, res) {
    try {
      const { phoneNumber, scenario } = req.body;
      const userId = getUserIdString(req);

      if (!phoneNumber) {
        return res.status(400).json({ message: 'Phone number is required' });
      }

      const result = await telephonyService.initiateOutboundCall(phoneNumber, req.twilioContext, scenario);

      await callStateService.createCall({
        callSid: result.callSid,
        phoneNumber,
        direction: 'outbound',
        provider: telephonyService.provider,
        scenario: scenario || null,
        userId
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
      const userId = getUserIdString(req);
      const call = await Call.findOne({ callSid, user: userId }).populate('user');

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
      const userId = getUserIdString(req);
      const [activeVoiceCalls, activeBroadcastCalls] = await Promise.all([
        Call.find({
          user: userId,
          status: { $in: ['initiated', 'ringing', 'in-progress'] }
        })
          .populate('user', 'name email')
          .sort({ createdAt: -1 })
          .limit(100)
          .lean(),
        BroadcastCall.find({
          userId,
          status: { $in: ['calling', 'ringing', 'in_progress', 'answered'] }
        })
          .sort({ createdAt: -1 })
          .limit(100)
          .select('callSid status contact startTime createdAt duration')
          .lean()
      ]);

      const normalizedBroadcastCalls = activeBroadcastCalls.map((call) => ({
        callSid: call.callSid || null,
        call_sid: call.callSid || null,
        status: call.status === 'in_progress' ? 'in-progress' : call.status,
        connected: ['in_progress', 'answered'].includes(call.status),
        phoneNumber: call?.contact?.phone || '',
        direction: 'outbound',
        source: 'broadcast',
        createdAt: call.createdAt,
        startTime: call.startTime,
        duration: call.duration || 0
      }));

      const normalizedVoiceCalls = activeVoiceCalls.map((call) => ({
        ...call,
        connected: call.status === 'in-progress',
        source: call.direction === 'outbound' ? 'outbound' : 'inbound'
      }));

      const activeCalls = [...normalizedVoiceCalls, ...normalizedBroadcastCalls]
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
        .slice(0, 100);

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
      const userId = getUserIdString(req);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const calls = await Call.find({ user: userId, createdAt: { $gte: today } });

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
      const userId = getUserIdString(req);

      if (!callSid) {
        return res.status(400).json({ success: false, message: 'Call SID is required' });
      }

      await telephonyService.endCall(callSid, req.twilioContext);
      await callStateService.endCall(callSid);

      await Call.updateOne(
        { callSid, user: userId },
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
