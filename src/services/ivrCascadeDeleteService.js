import mongoose from 'mongoose';
import Workflow from '../models/Workflow.js';
import ExecutionLog from '../models/ExecutionLog.js';
import WorkflowExecution from '../models/WorkflowExecution.js';
import AppointmentBooking from '../models/AppointmentBooking.js';
import BookingSlot from '../models/BookingSlot.js';
import BookingNotificationLog from '../models/BookingNotificationLog.js';
import Call from '../models/call.js';
import OutboundCampaign from '../models/OutboundCampaign.js';
import ivrWorkflowEngine from './ivrWorkflowEngine.js';
import callStateService from './callStateService.js';
import inboundCallService from './inboundCallService.js';
import { collectVoiceAudioAssets, deleteVoiceAudioAssets } from '../utils/voiceAssetCleanup.js';
import logger from '../utils/logger.js';

const toObjectId = (value) => {
  const normalized = String(value || '').trim();
  return mongoose.Types.ObjectId.isValid(normalized) ? new mongoose.Types.ObjectId(normalized) : null;
};

const normalizeId = (value) => String(value || '').trim();

const deleteManyCount = async (model, filter) => {
  const result = await model.deleteMany(filter);
  return result.deletedCount || 0;
};

class IVRCascadeDeleteService {
  async resolveWorkflow({ workflowId = '', userId = null } = {}) {
    const objectId = toObjectId(workflowId);
    const query = objectId ? { _id: objectId } : { promptKey: normalizeId(workflowId) };
    const ownerId = toObjectId(userId);
    if (ownerId) {
      query.createdBy = ownerId;
    }
    return Workflow.findOne(query);
  }

  async closeActiveExecutions(workflowId) {
    const closedCallSids = [];
    const normalizedWorkflowId = normalizeId(workflowId);

    for (const [callSid, state] of ivrWorkflowEngine.activeExecutions.entries()) {
      if (normalizeId(state?.workflowId) !== normalizedWorkflowId) continue;

      try {
        await ivrWorkflowEngine.endExecution(callSid, 'user_hangup', 'Workflow deleted');
      } catch (error) {
        logger.warn(`Failed to end active IVR execution ${callSid} during workflow delete: ${error.message}`);
        ivrWorkflowEngine.activeExecutions.delete(callSid);
      }

      callStateService.activeCalls.delete(callSid);
      closedCallSids.push(callSid);
    }

    return closedCallSids;
  }

  async deleteWorkflow({ workflowId = '', userId = null } = {}) {
    const workflow = await this.resolveWorkflow({ workflowId, userId });
    if (!workflow) {
      throw new Error('Workflow not found');
    }

    const workflowObjectId = workflow._id;
    const normalizedWorkflowId = normalizeId(workflowObjectId);
    const ownerId = toObjectId(userId);
    const promptKey = normalizeId(workflow.promptKey);

    logger.info(`Cascade deleting IVR workflow ${normalizedWorkflowId}`);

    const activeExecutionCallSids = await this.closeActiveExecutions(normalizedWorkflowId);

    const [executionLogs, workflowExecutions, bookings] = await Promise.all([
      ExecutionLog.find({ workflowId: workflowObjectId }).select('callSid').lean(),
      WorkflowExecution.find({ workflowId: workflowObjectId }).select('callSid').lean(),
      AppointmentBooking.find({ workflowId: workflowObjectId }).select('callSid').lean()
    ]);

    const callSids = [
      ...activeExecutionCallSids,
      ...executionLogs.map((item) => item.callSid),
      ...workflowExecutions.map((item) => item.callSid),
      ...bookings.map((item) => item.callSid)
    ]
      .map((value) => normalizeId(value))
      .filter(Boolean);
    const uniqueCallSids = [...new Set(callSids)];

    const audioAssets = collectVoiceAudioAssets(workflow);
    const deletedAudioAssetIds = audioAssets
      .map((asset) => asset.publicId || asset.url || '')
      .filter(Boolean);
    const cloudinaryCleanup = await deleteVoiceAudioAssets([workflow], {
      type: 'ivr-workflow-cascade-delete',
      workflowId: normalizedWorkflowId,
      userId: normalizeId(workflow.createdBy || ownerId || '')
    });

    const deletedCounts = {};
    deletedCounts.bookingNotificationLogs = await deleteManyCount(BookingNotificationLog, { workflowId: workflowObjectId });
    deletedCounts.appointmentBookings = await deleteManyCount(AppointmentBooking, { workflowId: workflowObjectId });
    deletedCounts.bookingSlots = await deleteManyCount(BookingSlot, { workflowId: workflowObjectId });
    deletedCounts.executionLogs = await deleteManyCount(ExecutionLog, { workflowId: workflowObjectId });
    deletedCounts.workflowExecutions = await deleteManyCount(WorkflowExecution, { workflowId: workflowObjectId });

    const callFilters = [
      { 'providerData.workflowId': workflowObjectId },
      { 'providerData.ivrWorkflowId': workflowObjectId },
      { 'providerData.workflow_id': workflowObjectId },
      { 'providerData.workflowId': normalizedWorkflowId },
      { 'providerData.ivrWorkflowId': normalizedWorkflowId },
      { 'providerData.workflow_id': normalizedWorkflowId }
    ];
    if (uniqueCallSids.length > 0) {
      callFilters.push({ callSid: { $in: uniqueCallSids } });
    }
    if (promptKey) {
      callFilters.push({ routing: promptKey });
    }

    deletedCounts.calls = await deleteManyCount(Call, {
      ...(ownerId ? { user: ownerId } : {}),
      $or: callFilters
    });

    const campaignUpdate = await OutboundCampaign.updateMany(
      { 'ivrWorkflow.workflowId': workflowObjectId, ...(ownerId ? { userId: ownerId } : {}) },
      {
        $set: {
          'ivrWorkflow.workflowId': null,
          'ivrWorkflow.workflowName': '',
          'ivrWorkflow.reuseInboundFlow': false
        }
      }
    );

    deletedCounts.workflows = await deleteManyCount(Workflow, {
      _id: workflowObjectId,
      ...(ownerId ? { createdBy: ownerId } : {})
    });

    if (promptKey) {
      inboundCallService.ivrMenus.delete(promptKey);
    }

    return {
      success: true,
      workflowId: normalizedWorkflowId,
      promptKey,
      deleted: true,
      deletedAudioAssetIds,
      cloudinary: cloudinaryCleanup,
      deletedCounts,
      activeExecutionsClosed: activeExecutionCallSids.length,
      activeExecutionCallSids,
      campaignReferencesUnlinked: campaignUpdate.modifiedCount || 0,
      leadsPreserved: true
    };
  }
}

export default new IVRCascadeDeleteService();
