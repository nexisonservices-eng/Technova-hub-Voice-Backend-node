import crypto from 'crypto';
import twilio from 'twilio';
import mongoose from 'mongoose';
import Workflow from '../models/Workflow.js';
import Call from '../models/call.js';
import ExecutionLog from '../models/ExecutionLog.js';
import OutboundCampaign from '../models/OutboundCampaign.js';
import OutboundCampaignContact from '../models/OutboundCampaignContact.js';
import exotelService from './ExotelService.js';
import pythonTTSService from './pythonTTSService.js';
import ivrWorkflowEngine from './ivrWorkflowEngine.js';
import adminCredentialsService from './adminCredentialsService.js';
import logger from '../utils/logger.js';
import { emitCampaignUpdate, emitOutboundMetrics } from '../sockets/unifiedSocket.js';

const LOCAL_MOBILE_REGEX = /^\+91[6-9][0-9]{9}$/;
const E164_REGEX = /^\+[1-9][0-9]{7,14}$/;

const normalizeLocalNumber = (value = '') => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) return `+${digits}`;
  if (String(value || '').trim().startsWith('+91') && LOCAL_MOBILE_REGEX.test(String(value || '').trim())) {
    return String(value || '').trim();
  }
  return '';
};

const parseCsvContacts = (csvText = '') => {
  const lines = String(csvText || '').split(/\r?\n/).filter((line) => String(line || '').trim());
  if (!lines.length) return [];

  const headers = lines[0].split(',').map((item) => String(item || '').trim().toLowerCase());
  const rows = lines.slice(1);

  return rows.map((line, index) => {
    const values = line.split(',').map((item) => String(item || '').trim());
    const row = headers.reduce((acc, header, position) => {
      acc[header] = values[position] || '';
      return acc;
    }, {});
    const candidate = row.phone || row.mobile || row.number || row.to || values[0] || '';
    const phone = normalizeLocalNumber(candidate);
    if (!phone) return null;

    const customFields = {};
    Object.keys(row).forEach((key) => {
      if (!['phone', 'mobile', 'number', 'to', 'name'].includes(key) && row[key]) {
        customFields[key] = row[key];
      }
    });

    return {
      phone,
      name: row.name || `Contact ${index + 1}`,
      customFields
    };
  }).filter(Boolean);
};

const buildMetrics = (initiated, failed, total) => ({
  initiated,
  failed,
  total,
  successRate: total > 0 ? Math.round((initiated / total) * 100) : 0
});

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_ALLOWED_WINDOW_START = '09:00';
const DEFAULT_ALLOWED_WINDOW_END = '21:00';

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const isValidTimeWindow = (value = '') => /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || '').trim());

const timeWindowToMinutes = (value = '') => {
  const [hourText = '0', minuteText = '0'] = String(value || '').trim().split(':');
  return (parsePositiveInt(hourText, 0) * 60) + parsePositiveInt(minuteText, 0);
};

const getDateTimePartsInTimezone = (date, timezone = DEFAULT_TIMEZONE) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short'
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    year: parsePositiveInt(parts.year, date.getUTCFullYear()),
    month: parsePositiveInt(parts.month, date.getUTCMonth() + 1),
    day: parsePositiveInt(parts.day, date.getUTCDate()),
    hour: parsePositiveInt(parts.hour, date.getUTCHours()),
    minute: parsePositiveInt(parts.minute, date.getUTCMinutes()),
    second: parsePositiveInt(parts.second, date.getUTCSeconds()),
    weekday: weekdayMap[parts.weekday] ?? date.getUTCDay()
  };
};

class OutboundCampaignService {
  constructor() {
    this.audioCache = new Map();
    this.executionLocks = new Map();
  }

  toCampaignPayload(campaign = {}) {
    const source = typeof campaign?.toObject === 'function' ? campaign.toObject() : campaign;
    return {
      _id: source?._id,
      campaignId: source?.campaignId || '',
      name: source?.name || '',
      provider: source?.provider || '',
      mode: source?.mode || '',
      status: source?.status || '',
      fromNumber: source?.fromNumber || '',
      metrics: source?.metrics || {},
      contactSummary: source?.contactSummary || {},
      voice: source?.voice || {},
      schedule: source?.schedule || {},
      ivrWorkflow: source?.ivrWorkflow || {},
      createdAt: source?.createdAt || null,
      updatedAt: source?.updatedAt || null
    };
  }

  emitCampaignState(userId, campaign, action = 'updated', extra = {}) {
    if (!campaign) return;

    emitCampaignUpdate(String(userId || campaign?.userId || ''), {
      action,
      campaign: this.toCampaignPayload(campaign),
      ...extra
    });
  }

  async resolveWorkflow(workflowId, userId) {
    if (!workflowId || !mongoose.Types.ObjectId.isValid(String(workflowId))) {
      return null;
    }

    const workflow = await Workflow.findOne({
      _id: workflowId,
      createdBy: userId,
      isActive: true
    })
      .select('_id promptKey displayName nodes')
      .lean();

    if (!workflow) {
      throw new Error('Selected IVR workflow was not found');
    }

    const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
    const startNode = nodes.find((node) => node.type === 'greeting' || node.type === 'audio') || nodes[0];
    if (!startNode?.id) {
      throw new Error('Selected IVR workflow has no valid start node');
    }

    return {
      workflowId: workflow._id,
      workflowName: workflow.displayName || workflow.promptKey || 'IVR Workflow',
      startNodeId: startNode.id
    };
  }

  async resolveTwilioContext({ userId = '', from = '' }) {
    const byUser = await adminCredentialsService.getTwilioCredentialsByUserId(userId);
    const byPhone = from ? await adminCredentialsService.getTwilioCredentialsByPhoneNumber(from) : null;
    const merged = { ...(byUser || {}), ...(byPhone || {}) };

    const pick = (...names) => {
      for (const name of names) {
        const value = String(merged?.[name] || '').trim();
        if (value) return value;
      }
      return '';
    };

    const accountSid = pick('twilioAccountSid', 'accountSid', 'sid', 'TWILIO_ACCOUNT_SID');
    const authToken = pick('twilioAuthToken', 'authToken', 'token', 'TWILIO_AUTH_TOKEN');
    const phoneNumber = pick('twilioPhoneNumber', 'phoneNumber', 'fromNumber', 'TWILIO_PHONE_NUMBER');

    if (!accountSid || !authToken) {
      throw new Error('Twilio credentials not found for this user.');
    }

    return { accountSid, authToken, phoneNumber };
  }

  buildTwilioCampaignTwiML({ audioUrl = '', script = '' }) {
    const response = new twilio.twiml.VoiceResponse();

    if (audioUrl) {
      response.play(audioUrl);
    } else if (script) {
      response.say({ voice: 'alice', language: 'en-IN' }, script);
    } else {
      response.say({ voice: 'alice', language: 'en-IN' }, 'Thank you. Please stay on the line.');
    }

    response.hangup();
    return response.toString();
  }

  async resolveScriptAudioAsset({ script = '', voiceId = 'en-GB-SoniaNeural', language = 'en-GB' }) {
    const text = String(script || '').trim();
    if (!text) {
      return { audioUrl: '', audioAssetId: '' };
    }

    const hash = crypto.createHash('sha1').update(`${voiceId}|${language}|${text}`).digest('hex');
    if (this.audioCache.has(hash)) {
      return this.audioCache.get(hash);
    }

    try {
      const audioData = await pythonTTSService.getAudioForPrompt(
        `outbound_campaign_${hash}`,
        text,
        language,
        voiceId,
        null,
        { id: `outbound_campaign_${hash}`, type: 'outbound-campaign' }
      );

      const result = {
        audioUrl: String(audioData?.audioUrl || '').trim(),
        audioAssetId: String(audioData?.publicId || '').trim()
      };
      this.audioCache.set(hash, result);
      return result;
    } catch (error) {
      logger.warn('Outbound campaign TTS generation failed, continuing with text fallback.', {
        message: error.message
      });
      return { audioUrl: '', audioAssetId: '' };
    }
  }

  async annotateExecution(callSid, metadata = {}) {
    const state = ivrWorkflowEngine.getExecutionState(callSid);
    if (state) {
      state.variables = {
        ...(state.variables || {}),
        ...metadata
      };
      if (state.executionLogId) {
        await ExecutionLog.findByIdAndUpdate(state.executionLogId, {
          $set: { variables: state.variables }
        });
      }
    }
  }

  normalizeScheduleConfig(payload = {}) {
    const scheduleTypeRaw = String(payload?.scheduleType || payload?.schedule?.scheduleType || 'immediate').trim().toLowerCase();
    const recurrenceRaw = String(payload?.recurrence || payload?.schedule?.recurrence || 'none').trim().toLowerCase();
    const scheduleType = ['immediate', 'once', 'recurring'].includes(scheduleTypeRaw)
      ? scheduleTypeRaw
      : 'immediate';
    const recurrence = ['none', 'daily', 'weekly'].includes(recurrenceRaw)
      ? recurrenceRaw
      : 'none';
    const timezone = String(payload?.timezone || payload?.schedule?.timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
    const allowedWindowStart = String(payload?.allowedWindowStart || payload?.schedule?.allowedWindowStart || DEFAULT_ALLOWED_WINDOW_START).trim();
    const allowedWindowEnd = String(payload?.allowedWindowEnd || payload?.schedule?.allowedWindowEnd || DEFAULT_ALLOWED_WINDOW_END).trim();
    const scheduledAtRaw = payload?.scheduledAt || payload?.schedule?.scheduledAt || null;
    const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null;

    return {
      scheduleType,
      recurrence,
      timezone,
      allowedWindowStart,
      allowedWindowEnd,
      scheduledAt
    };
  }

  validateScheduleConfig({
    scheduleType = 'immediate',
    recurrence = 'none',
    scheduledAt = null,
    allowedWindowStart = DEFAULT_ALLOWED_WINDOW_START,
    allowedWindowEnd = DEFAULT_ALLOWED_WINDOW_END
  } = {}) {
    if (!isValidTimeWindow(allowedWindowStart) || !isValidTimeWindow(allowedWindowEnd)) {
      throw new Error('Allowed time window must use HH:mm format.');
    }

    if (timeWindowToMinutes(allowedWindowStart) >= timeWindowToMinutes(allowedWindowEnd)) {
      throw new Error('Allowed time window start must be earlier than the end time.');
    }

    if (scheduleType === 'once') {
      if (!(scheduledAt instanceof Date) || Number.isNaN(scheduledAt.getTime())) {
        throw new Error('A valid scheduledAt date is required for one-time campaigns.');
      }
      if (scheduledAt.getTime() <= Date.now()) {
        throw new Error('scheduledAt must be in the future for one-time campaigns.');
      }
    }

    if (scheduleType === 'recurring' && !['daily', 'weekly'].includes(recurrence)) {
      throw new Error('Recurring campaigns must use daily or weekly recurrence.');
    }
  }

  getCampaignMaxConcurrent(campaign = {}) {
    return clamp(parsePositiveInt(campaign?.metadata?.maxConcurrent, 5), 1, 10);
  }

  async processInBatches(items = [], batchSize = 5, handler) {
    const results = [];
    const normalizedBatchSize = clamp(parsePositiveInt(batchSize, 5), 1, 10);

    for (let index = 0; index < items.length; index += normalizedBatchSize) {
      const batch = items.slice(index, index + normalizedBatchSize);
      const batchResults = await Promise.allSettled(
        batch.map((item, batchIndex) => handler(item, index + batchIndex))
      );
      results.push(...batchResults);
    }

    return results;
  }

  async createCampaign(payload, userId, { autoExecute = true, createSchedule = true } = {}) {
    const provider = String(payload?.provider || 'exotel').trim().toLowerCase();
    const name = String(payload?.campaignName || payload?.name || '').trim();
    const fromNumber = String(payload?.from || '').trim();
    const message = String(payload?.customMessage || payload?.message || '').trim();
    const voiceId = String(payload?.voiceId || payload?.voice || 'en-GB-SoniaNeural').trim();
    const voiceProvider = String(payload?.voiceProvider || 'edge').trim();
    const voiceLanguage = String(payload?.language || payload?.voiceLanguage || voiceId.split('-').slice(0, 2).join('-') || 'en-GB').trim();
    const {
      scheduleType,
      recurrence,
      scheduledAt,
      timezone,
      allowedWindowStart,
      allowedWindowEnd
    } = this.normalizeScheduleConfig(payload);
    const workflow = await this.resolveWorkflow(payload?.workflowId, userId);
    const maxConcurrent = clamp(parsePositiveInt(payload?.maxConcurrent, 5), 1, 10);

    if (!['exotel', 'twilio'].includes(provider)) {
      throw new Error('Invalid provider. Supported providers are exotel and twilio.');
    }
    if (!name || name.length < 3 || name.length > 80) {
      throw new Error('Campaign name must be between 3 and 80 characters.');
    }
    if (!message) {
      throw new Error('Audio message is required.');
    }
    if (provider === 'exotel' && !LOCAL_MOBILE_REGEX.test(fromNumber)) {
      throw new Error('Invalid Exotel from number. Expected +91XXXXXXXXXX.');
    }
    if (provider === 'twilio' && fromNumber && !E164_REGEX.test(fromNumber)) {
      throw new Error('Invalid Twilio from number. Expected E.164 format.');
    }

    this.validateScheduleConfig({
      scheduleType,
      recurrence,
      scheduledAt,
      allowedWindowStart,
      allowedWindowEnd
    });

    const bodyContacts = Array.isArray(payload?.contacts) ? payload.contacts : [];
    const numberContacts = Array.isArray(payload?.numbers)
      ? payload.numbers.map((phone, index) => ({
          phone,
          name: `Contact ${index + 1}`,
          customFields: {}
        }))
      : [];
    const csvContacts = parseCsvContacts(payload?.csvData || payload?.csv || '');
    const mergedContacts = [...bodyContacts, ...numberContacts, ...csvContacts]
      .map((item, index) => {
        const phone = normalizeLocalNumber(item?.phone || item?.mobile || item?.number || item?.to || '');
        if (!phone) return null;
        return {
          phone,
          name: String(item?.name || `Contact ${index + 1}`).trim(),
          customFields: item?.customFields && typeof item.customFields === 'object' ? item.customFields : {}
        };
      })
      .filter(Boolean);

    const contacts = Array.from(new Map(mergedContacts.map((item) => [item.phone, item])).values());
    if (!contacts.length) {
      throw new Error('No valid contacts found for this campaign.');
    }

    const campaignKey = `outbound_campaign_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const mode =
      scheduleType === 'immediate'
        ? 'immediate'
        : recurrence === 'none'
        ? 'scheduled'
        : 'recurring';

    const campaign = await OutboundCampaign.create({
      userId,
      campaignId: campaignKey,
      name,
      provider,
      mode,
      status: scheduleType === 'immediate' ? 'draft' : 'scheduled',
      fromNumber,
      message,
      voice: {
        voiceId,
        provider: voiceProvider,
        language: voiceLanguage
      },
      ivrWorkflow: workflow
        ? {
            workflowId: workflow.workflowId,
            workflowName: workflow.workflowName,
            reuseInboundFlow: true
          }
        : undefined,
      schedule: {
        enabled: scheduleType !== 'immediate',
        scheduleType,
        scheduledAt: scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt : null,
        recurrence,
        timezone,
        allowedWindowStart,
        allowedWindowEnd
      },
      contactSummary: {
        total: contacts.length,
        pending: contacts.length
      },
      metadata: {
        maxConcurrent,
        templateId: String(payload?.templateId || '').trim()
      }
    });

    await OutboundCampaignContact.insertMany(
      contacts.map((contact) => ({
        campaignId: campaign._id,
        campaignKey,
        phone: contact.phone,
        name: contact.name,
        customFields: contact.customFields
      }))
    );

    if (campaign.schedule.enabled && createSchedule) {
      const cronExpression = this.buildCronExpression({
        scheduleType,
        recurrence,
        scheduledAt,
        allowedWindowStart,
        timezone
      });
      const { default: campaignAutomationService } = await import('./campaignAutomationService.js');
      const scheduleDoc = await campaignAutomationService.createSchedule(
        {
          campaignId: campaign.campaignId,
          campaignName: campaign.name,
          numbers: contacts.map((contact) => contact.phone),
          fromNumbers: [fromNumber].filter(Boolean),
          cronExpression,
          timezone,
          recurrence: recurrence === 'none' ? 'once' : recurrence,
          metadata: {
            outboundCampaignId: String(campaign._id),
            workflowId: workflow?.workflowId ? String(workflow.workflowId) : '',
            provider,
            scheduledAt: scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt.toISOString() : '',
            allowedWindowStart,
            allowedWindowEnd
          }
        },
        userId
      );

      campaign.schedule.scheduleId = scheduleDoc._id;
      campaign.schedule.cronExpression = cronExpression;
      campaign.schedule.nextRunAt = scheduleDoc.nextRunAt || scheduledAt || null;
      await campaign.save();
    }

    if (scheduleType === 'immediate' && autoExecute) {
      await this.executeCampaignById(campaign._id, { trigger: 'manual' });
    } else {
      this.emitCampaignState(userId, campaign, campaign.schedule?.enabled ? 'scheduled' : 'created');
    }

    return campaign;
  }

  buildCronExpression({ scheduleType, recurrence, scheduledAt, allowedWindowStart, timezone = DEFAULT_TIMEZONE }) {
    const [hourText = '9', minuteText = '0'] = String(allowedWindowStart || DEFAULT_ALLOWED_WINDOW_START).split(':');
    const defaultHour = Number.parseInt(hourText, 10);
    const defaultMinute = Number.parseInt(minuteText, 10);

    if (scheduleType === 'once' && scheduledAt instanceof Date && !Number.isNaN(scheduledAt.getTime())) {
      const parts = getDateTimePartsInTimezone(scheduledAt, timezone);
      return `${parts.minute} ${parts.hour} ${parts.day} ${parts.month} *`;
    }

    if (recurrence === 'weekly') {
      const weekday = scheduledAt instanceof Date && !Number.isNaN(scheduledAt.getTime())
        ? getDateTimePartsInTimezone(scheduledAt, timezone).weekday
        : 1;
      return `${Number.isFinite(defaultMinute) ? defaultMinute : 0} ${Number.isFinite(defaultHour) ? defaultHour : 9} * * ${weekday}`;
    }

    return `${Number.isFinite(defaultMinute) ? defaultMinute : 0} ${Number.isFinite(defaultHour) ? defaultHour : 9} * * *`;
  }

  async executeCampaignById(campaignId, { trigger = 'manual', scheduleId = '' } = {}) {
    const executionKey = `${campaignId}:${scheduleId || trigger}`;
    if (this.executionLocks.has(executionKey)) {
      return this.executionLocks.get(executionKey);
    }

    const executionPromise = this._executeCampaignById(campaignId, { trigger, scheduleId });
    this.executionLocks.set(executionKey, executionPromise);

    try {
      return await executionPromise;
    } finally {
      this.executionLocks.delete(executionKey);
    }
  }

  async _executeCampaignById(campaignId, { trigger = 'manual', scheduleId = '' } = {}) {
    const campaign = await OutboundCampaign.findById(campaignId);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const contacts = await OutboundCampaignContact.find({
      campaignId: campaign._id,
      status: { $in: ['pending', 'failed', 'no-answer', 'busy'] }
    }).sort({ createdAt: 1 });

    if (!contacts.length) {
      campaign.status = 'completed';
      await campaign.save();
      return { campaign, total: 0, initiated: 0, failed: 0 };
    }

    const workflow = campaign.ivrWorkflow?.workflowId
      ? await this.resolveWorkflow(campaign.ivrWorkflow.workflowId, campaign.userId)
      : null;
    const audioAsset = await this.resolveScriptAudioAsset({
      script: campaign.message,
      voiceId: campaign.voice?.voiceId || 'en-GB-SoniaNeural',
      language: campaign.voice?.language || 'en-GB'
    });

    let initiated = 0;
    let failed = 0;
    campaign.status = 'running';
    campaign.schedule.lastRunAt = new Date();
    await campaign.save();
    this.emitCampaignState(campaign.userId, campaign, 'running', { trigger, scheduleId });

    const batchResults = await this.processInBatches(
      contacts,
      this.getCampaignMaxConcurrent(campaign),
      async (contact) => {
        try {
          const result = await this.placeCampaignCall({
            campaign,
            contact,
            workflow,
            audioAsset,
            scheduleId
          });

          contact.status = 'initiated';
          contact.attempts = Number(contact.attempts || 0) + 1;
          contact.lastAttemptAt = new Date();
          contact.lastCallSid = result.callSid;
          await contact.save();
          return { initiated: 1, failed: 0 };
        } catch (error) {
          contact.status = 'failed';
          contact.attempts = Number(contact.attempts || 0) + 1;
          contact.lastAttemptAt = new Date();
          await contact.save();
          return { initiated: 0, failed: 1 };
        }
      }
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        initiated += Number(result.value?.initiated || 0);
        failed += Number(result.value?.failed || 0);
      } else {
        failed += 1;
      }
    }

    const refreshedCampaign = await this.refreshCampaignMetrics(campaign._id);
    emitOutboundMetrics(String(campaign.userId), {
      mode: campaign.schedule?.enabled ? 'scheduled' : 'bulk',
      campaignId: campaign.campaignId,
      campaignName: campaign.name,
      completed: true,
      trigger,
      ...buildMetrics(initiated, failed, contacts.length)
    });
    this.emitCampaignState(campaign.userId, refreshedCampaign || campaign, 'executed', {
      trigger,
      scheduleId,
      initiated,
      failed,
      total: contacts.length
    });

    return { campaignId: campaign.campaignId, total: contacts.length, initiated, failed };
  }

  async placeCampaignCall({ campaign, contact, workflow, audioAsset, scheduleId }) {
    const baseUrl = String(process.env.BASE_URL || '').replace(/\/$/, '');
    const appParams = {
      campaignId: campaign.campaignId,
      campaignDbId: String(campaign._id),
      contactId: String(contact._id),
      campaignName: campaign.name,
      workflowId: workflow?.workflowId ? String(workflow.workflowId) : '',
      startNodeId: workflow?.startNodeId || '',
      userId: String(campaign.userId),
      script: campaign.message || '',
      audioUrl: audioAsset.audioUrl || '',
      voiceId: campaign.voice?.voiceId || '',
      scheduleId: scheduleId || String(campaign.schedule?.scheduleId || '')
    };

    let callSid = '';
    let raw = {};

    if (campaign.provider === 'twilio') {
      const twilioContext = await this.resolveTwilioContext({
        userId: String(campaign.userId),
        from: campaign.fromNumber
      });
      const client = twilio(twilioContext.accountSid, twilioContext.authToken);
      const fromNumber = String(campaign.fromNumber || twilioContext.phoneNumber || '').trim();
      if (!E164_REGEX.test(fromNumber)) {
        throw new Error('Twilio from number is missing or invalid.');
      }
      if (workflow?.workflowId && !baseUrl) {
        throw new Error('BASE_URL is required for outbound IVR callbacks.');
      }

      const callPayload = {
        to: contact.phone,
        from: fromNumber,
        ...(workflow?.workflowId
          ? {
              url: `${baseUrl}/webhook/outbound-local/workflow/start/${workflow.workflowId}?campaignId=${encodeURIComponent(campaign.campaignId)}&contactId=${encodeURIComponent(String(contact._id))}`,
              method: 'POST'
            }
          : {
              twiml: this.buildTwilioCampaignTwiML({
                audioUrl: audioAsset.audioUrl || '',
                script: campaign.message || ''
              })
            }),
        timeout: 25
      };

      if (baseUrl) {
        callPayload.statusCallback = `${baseUrl}/webhook/twilio/status`;
        callPayload.statusCallbackMethod = 'POST';
        callPayload.statusCallbackEvent = ['initiated', 'ringing', 'answered', 'completed'];
      }

      const call = await client.calls.create(callPayload);
      callSid = String(call.sid || '');
      raw = {
        sid: call.sid,
        status: call.status,
        to: call.to,
        from: call.from
      };
    } else {
      const exotelCall = await exotelService.createOutboundLocalCall({
        to: contact.phone,
        from: campaign.fromNumber,
        appParams
      });
      callSid = String(exotelCall.callSid || '');
      raw = exotelCall.raw || {};
    }

    await Call.create({
      callSid,
      exotelCallSid: campaign.provider === 'exotel' ? callSid : '',
      user: campaign.userId,
      phoneNumber: contact.phone,
      direction: 'outbound-local',
      provider: campaign.provider,
      status: 'initiated',
      retryAttempt: 0,
      startTime: new Date(),
      providerData: {
        from: campaign.fromNumber,
        campaignId: campaign.campaignId,
        campaignDbId: String(campaign._id),
        campaignName: campaign.name,
        contactId: String(contact._id),
        workflowId: workflow?.workflowId ? String(workflow.workflowId) : '',
        workflowName: workflow?.workflowName || '',
        voiceId: campaign.voice?.voiceId || '',
        script: campaign.message || '',
        audioUrl: audioAsset.audioUrl || '',
        scheduleId: scheduleId || String(campaign.schedule?.scheduleId || ''),
        [campaign.provider]: raw
      }
    });

    if (workflow?.workflowId) {
      if (campaign.provider !== 'twilio') {
        await ivrWorkflowEngine.startExecution(
          workflow.workflowId,
          callSid,
          contact.phone,
          campaign.fromNumber,
          campaign.userId
        );
      }
      await this.annotateExecution(callSid, {
        outboundCampaignId: String(campaign._id),
        campaignId: campaign.campaignId,
        campaignContactId: String(contact._id),
        trigger: 'outbound_campaign',
        provider: campaign.provider
      });
    }

    return { callSid };
  }

  async refreshCampaignMetrics(campaignId) {
    const contacts = await OutboundCampaignContact.find({ campaignId }).select('status responseSummary').lean();
    const summary = {
      total: contacts.length,
      pending: contacts.filter((item) => item.status === 'pending').length,
      contacted: contacts.filter((item) => item.status !== 'pending').length,
      answered: contacts.filter((item) => ['answered', 'completed'].includes(item.status)).length,
      failed: contacts.filter((item) => ['failed', 'busy', 'no-answer'].includes(item.status)).length
    };

    const metrics = {
      initiated: contacts.filter((item) => ['initiated', 'ringing', 'answered', 'completed'].includes(item.status)).length,
      ringing: contacts.filter((item) => item.status === 'ringing').length,
      answered: contacts.filter((item) => item.status === 'answered').length,
      completed: contacts.filter((item) => item.status === 'completed').length,
      failed: contacts.filter((item) => item.status === 'failed').length,
      busy: contacts.filter((item) => item.status === 'busy').length,
      noAnswer: contacts.filter((item) => item.status === 'no-answer').length,
      ivrInteractions: contacts.filter((item) => item?.responseSummary?.interacted).length,
      lastStatusAt: new Date()
    };

    const status =
      summary.pending === summary.total && summary.total > 0
        ? 'scheduled'
        : summary.failed === summary.total && summary.total > 0
        ? 'failed'
        : summary.pending > 0
        ? 'running'
        : metrics.failed > 0 || metrics.busy > 0 || metrics.noAnswer > 0
        ? 'partial'
        : 'completed';

    const updatedCampaign = await OutboundCampaign.findByIdAndUpdate(campaignId, {
      $set: {
        contactSummary: summary,
        metrics,
        status
      }
    }, { new: true });

    if (updatedCampaign) {
      this.emitCampaignState(updatedCampaign.userId, updatedCampaign, 'status_updated', {
        summary,
        metrics
      });
    }

    return updatedCampaign;
  }

  async syncCallUpdate(callSid, status, duration = 0) {
    const call = await Call.findOne({ callSid }).select('providerData user').lean();
    if (!call?.providerData?.campaignDbId || !call?.providerData?.contactId) {
      return;
    }

    await OutboundCampaignContact.findByIdAndUpdate(call.providerData.contactId, {
      $set: {
        status,
        lastCallSid: callSid,
        ...(duration > 0 ? { updatedAt: new Date() } : {})
      }
    });

    await this.syncResponsesFromExecution(callSid);
    const campaign = await this.refreshCampaignMetrics(call.providerData.campaignDbId);
    if (campaign) {
      emitOutboundMetrics(String(call.user || campaign.userId || ''), {
        mode: campaign.schedule?.enabled ? 'scheduled' : 'bulk',
        campaignId: campaign.campaignId,
        campaignName: campaign.name,
        total: Number(campaign.contactSummary?.total || 0),
        initiated: Number(campaign.metrics?.initiated || 0),
        failed: Number(campaign.metrics?.failed || 0) + Number(campaign.metrics?.busy || 0) + Number(campaign.metrics?.noAnswer || 0),
        successRate: Number(campaign.contactSummary?.total || 0) > 0
          ? Math.round((Number(campaign.metrics?.initiated || 0) / Number(campaign.contactSummary?.total || 1)) * 100)
          : 0,
        progress: Number(campaign.contactSummary?.total || 0) > 0
          ? Math.round((Number(campaign.contactSummary?.contacted || 0) / Number(campaign.contactSummary?.total || 1)) * 100)
          : 0,
        completed: ['completed', 'failed', 'partial'].includes(String(campaign.status || '').toLowerCase())
      });
    }
  }

  async syncResponsesFromExecution(callSid) {
    const call = await Call.findOne({ callSid }).select('providerData').lean();
    const contactId = call?.providerData?.contactId;
    if (!contactId) return;

    const log = await ExecutionLog.findOne({ callSid }).sort({ createdAt: -1 }).lean();
    if (!log) return;

    const responses = Array.isArray(log.userInputs)
      ? log.userInputs
          .map((item) => ({
            nodeId: String(item?.nodeId || ''),
            input: String(item?.input || ''),
            timestamp: item?.timestamp || new Date()
          }))
          .filter((item) => item.input)
      : [];

    await OutboundCampaignContact.findByIdAndUpdate(contactId, {
      $set: {
        workflowExecutionId: log._id,
        responses,
        responseSummary: {
          lastInput: responses[responses.length - 1]?.input || '',
          inputCount: responses.length,
          interacted: responses.length > 0
        }
      }
    });
  }

  async listCampaigns(userId, { page = 1, limit = 20 } = {}) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      OutboundCampaign.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      OutboundCampaign.countDocuments({ userId })
    ]);

    return {
      items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    };
  }
}

export default new OutboundCampaignService();
