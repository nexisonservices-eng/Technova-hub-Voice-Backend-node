import logger from '../utils/logger.js';
import Call from '../models/call.js';

class CallStateService {
  constructor() {
    this.activeCalls = new Map();
  }

  async createCall(callData) {
    const { callSid, phoneNumber, direction, provider, userId = null } = callData;
    const call = await Call.create({
      callSid,
      user: userId,
      phoneNumber,
      direction,
      provider,
      startTime: new Date(),
      status: 'initiated'
    });

    this.activeCalls.set(callSid, {
      call,
      user: userId ? { _id: userId } : null,
      startTime: Date.now(),
      aiClient: null,
      mediaStream: null
    });

    logger.info(`[${callSid}] Call created for user ${String(userId || 'unknown')}`);
    return { call, user: userId ? { _id: userId } : null };
  }

  getCallState(callSid) {
    return this.activeCalls.get(callSid);
  }

  updateCallState(callSid, updates) {
    const state = this.activeCalls.get(callSid);
    if (!state) return;
    Object.assign(state, updates);
    this.activeCalls.set(callSid, state);
  }

  async updateCallStatus(callSid, status, additionalData = {}) {
    const call = await Call.findOne({ callSid });
    if (!call) return null;
    call.status = status;
    Object.assign(call, additionalData);
    await call.save();
    return call;
  }

  async addConversation(callSid, type, text, audio = null) {
    const call = await Call.findOne({ callSid });
    if (!call) return null;
    await call.addConversation(type, text, audio);
    return call;
  }

  async updateAIMetrics(callSid, metrics) {
    const call = await Call.findOne({ callSid });
    if (!call) return null;
    await call.updateAIMetrics(metrics);
    return call;
  }

  async endCall(callSid) {
    const state = this.getCallState(callSid);
    const call = await Call.findOne({ callSid });
    if (call) {
      await call.endCall();
    }
    if (state?.aiClient) {
      state.aiClient.disconnect();
    }
    this.activeCalls.delete(callSid);
    return call;
  }

  getActiveCalls() {
    return Array.from(this.activeCalls.keys());
  }

  getActiveCallsCount() {
    return this.activeCalls.size;
  }

  async cleanupStaleCalls() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [callSid, state] of this.activeCalls.entries()) {
      if (state.startTime < oneHourAgo) {
        logger.warn(`[${callSid}] Cleaning stale call`);
        await this.endCall(callSid);
      }
    }
  }
}

export default new CallStateService();
