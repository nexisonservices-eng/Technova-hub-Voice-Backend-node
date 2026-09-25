import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { createAgentActivityHandler } from '../utils/agentActivity.js';
import Broadcast from '../models/Broadcast.js';
import Workflow from '../models/Workflow.js';
import OutboundCampaign from '../models/OutboundCampaign.js';
import CampaignSchedule from '../models/CampaignSchedule.js';
import Call from '../models/call.js';
import Lead from '../models/Lead.js';
import OutboundTemplate from '../models/OutboundTemplate.js';

const router = Router();
const registry = {
  broadcasts: { model: Broadcast, owner: 'createdBy', title: ['name'], label: 'Voice broadcast' },
  workflows: { model: Workflow, owner: 'createdBy', title: ['displayName', 'promptKey'], label: 'IVR workflow' },
  campaigns: { model: OutboundCampaign, owner: 'userId', title: ['name'], label: 'Outbound campaign' },
  schedules: { model: CampaignSchedule, owner: 'userId', title: ['campaignName', 'campaignId'], label: 'Call schedule' },
  calls: { model: Call, owner: 'user', title: ['phoneNumber', 'callSid'], label: 'Call', where: { deletedAt: null } },
  leads: { model: Lead, owner: 'user', title: ['name'], label: 'Lead' },
  templates: { model: OutboundTemplate, owner: 'createdBy', title: ['name'], label: 'Voice template' }
};
router.get('/:kind', authenticate, createAgentActivityHandler(registry));
export default router;
