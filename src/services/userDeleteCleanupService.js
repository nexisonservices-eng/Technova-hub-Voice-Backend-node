import mongoose from 'mongoose';
import Workflow from '../models/Workflow.js';
import WorkflowExecution from '../models/WorkflowExecution.js';
import ExecutionLog from '../models/ExecutionLog.js';
import InboundRoutingRule from '../models/InboundRoutingRule.js';
import Broadcast from '../models/Broadcast.js';
import BroadcastCall from '../models/BroadcastCall.js';
import OutboundCampaign from '../models/OutboundCampaign.js';
import OutboundCampaignContact from '../models/OutboundCampaignContact.js';
import OutboundTemplate from '../models/OutboundTemplate.js';
import CampaignSchedule from '../models/CampaignSchedule.js';
import Lead from '../models/Lead.js';
import Call from '../models/call.js';
import Message from '../models/message.js';
import User from '../models/user.js';
import OptOut from '../models/OptOut.js';
import { deleteAssets, deleteFolderPrefix } from '../utils/cloudinaryDeleteService.js';

const asObjectId = (value) =>
  mongoose.Types.ObjectId.isValid(String(value || '')) ? new mongoose.Types.ObjectId(String(value)) : null;

const buildCompanyRoot = ({ companyId, companyName = '', companySlug = '', cloudinaryFolderRoot = '' }) => {
  const explicit = String(cloudinaryFolderRoot || '').trim();
  if (explicit) return explicit;
  const slug = String(companySlug || companyName || 'company')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '') || 'company';
  return companyId ? `technova/${slug}_${companyId}` : '';
};

const countDelete = async (model, filter, counts, key) => {
  const result = await model.deleteMany(filter);
  counts[key] = result.deletedCount || 0;
};

const collectWorkflowAssets = (workflow = {}) => {
  const assets = [];
  const add = (value) => {
    if (value) assets.push({ publicId: value, resourceType: 'video' });
  };
  const scanNode = (node = {}) => {
    add(node.audioAssetId || node.audioPublicId || node.audio_public_id || node.cloudinaryPublicId);
    add(node.data?.audioAssetId || node.data?.audioPublicId || node.data?.audio_public_id || node.data?.cloudinaryPublicId);
    if (node.audioUrl) assets.push({ url: node.audioUrl, resourceType: 'video' });
    if (node.data?.audioUrl) assets.push({ url: node.data.audioUrl, resourceType: 'video' });
  };
  (workflow.nodes || []).forEach(scanNode);
  if (workflow.greeting?.audioUrl) assets.push({ url: workflow.greeting.audioUrl, resourceType: 'video' });
  add(workflow.greeting?.audioAssetId || workflow.greeting?.audioPublicId);
  return assets;
};

export const cleanupUserDelete = async ({ userId, companyId, deleteCompanyScope = false, companyName = '', companySlug = '', cloudinaryFolderRoot = '' } = {}) => {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    const error = new Error('userId is required');
    error.status = 400;
    throw error;
  }

  const userObjectId = asObjectId(normalizedUserId);
  const userFilter = userObjectId || normalizedUserId;
  const counts = {};
  const warnings = [];

  const workflows = await Workflow.find({ createdBy: userFilter }).lean();
  const broadcasts = await Broadcast.find({ createdBy: userFilter }).lean();
  const assets = [];
  workflows.forEach((workflow) => assets.push(...collectWorkflowAssets(workflow)));
  broadcasts.forEach((broadcast) => {
    (broadcast.audioAssets || []).forEach((asset) => {
      if (asset?.audioUrl) assets.push({ url: asset.audioUrl, resourceType: 'video' });
      if (asset?.audioAssetId || asset?.publicId) assets.push({ publicId: asset.audioAssetId || asset.publicId, resourceType: 'video' });
    });
  });

  const cloudinary = await deleteAssets(assets);
  warnings.push(...cloudinary.warnings);

  const broadcastIds = broadcasts.map((item) => item._id);
  const outboundCampaigns = await OutboundCampaign.find({ userId: normalizedUserId }).select('_id').lean();
  const outboundCampaignIds = outboundCampaigns.map((item) => item._id);

  await countDelete(Workflow, { createdBy: userFilter }, counts, 'workflows');
  await countDelete(WorkflowExecution, { userId: userFilter }, counts, 'workflowExecutions');
  await countDelete(ExecutionLog, { userId: userFilter }, counts, 'executionLogs');
  await countDelete(InboundRoutingRule, { userId: userFilter }, counts, 'inboundRoutingRules');
  await countDelete(Broadcast, { createdBy: userFilter }, counts, 'broadcasts');
  await countDelete(BroadcastCall, { $or: [{ userId: userFilter }, { broadcast: { $in: broadcastIds } }] }, counts, 'broadcastCalls');
  await countDelete(OutboundCampaign, { userId: normalizedUserId }, counts, 'outboundCampaigns');
  await countDelete(OutboundCampaignContact, { campaignId: { $in: outboundCampaignIds } }, counts, 'outboundCampaignContacts');
  await countDelete(OutboundTemplate, { createdBy: userFilter }, counts, 'outboundTemplates');
  await countDelete(CampaignSchedule, { userId: userFilter }, counts, 'campaignSchedules');
  await countDelete(Lead, { user: userFilter }, counts, 'leads');
  await countDelete(Call, { user: userFilter }, counts, 'calls');
  await countDelete(Message, { user: userFilter }, counts, 'messages');
  await countDelete(User, { _id: userFilter }, counts, 'localUsers');
  await countDelete(OptOut, { 'metadata.userId': normalizedUserId }, counts, 'optOuts');

  if (deleteCompanyScope && companyId) {
    const root = buildCompanyRoot({ companyId, companyName, companySlug, cloudinaryFolderRoot });
    const prefixResult = await deleteFolderPrefix(root);
    warnings.push(...(prefixResult.warnings || []));
  }

  return { counts, cloudinary, warnings };
};
