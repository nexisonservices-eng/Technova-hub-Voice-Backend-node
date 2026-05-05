import crypto from 'crypto';
import twilio from 'twilio';
import Call from '../models/call.js';
import Broadcast from '../models/Broadcast.js';
import OutboundLocalTemplate from '../models/OutboundTemplate.js';
import OutboundCampaign from '../models/OutboundCampaign.js';
import OutboundCampaignContact from '../models/OutboundCampaignContact.js';
import exotelService from '../services/ExotelService.js';
import pythonTTSService from '../services/pythonTTSService.js';
import adminCredentialsService from '../services/adminCredentialsService.js';
import logger from '../utils/logger.js';
import { emitOutboundCallUpdate, emitOutboundMetrics, emitOutboundTemplateUpdate } from '../sockets/unifiedSocket.js';
import { getUserIdString, getUserObjectId } from '../utils/authContext.js';
import mongoose from 'mongoose';
import outboundCampaignService from '../services/outboundCampaignService.js';
import { reportUsage } from '../services/usageService.js';

const LOCAL_MOBILE_REGEX = /^\+91[6-9][0-9]{9}$/;
const E164_REGEX = /^\+[1-9][0-9]{7,14}$/;

const normalizeLocalNumber = (value = '') => {
  const digits = String(value || '').replace(/\D/g, '');

  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `+91${digits}`;
  }

  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }

  if (String(value || '').startsWith('+91') && LOCAL_MOBILE_REGEX.test(String(value).trim())) {
    return String(value).trim();
  }

  return null;
};

const parseCsvNumbers = (csvText = '') => {
  const rows = String(csvText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!rows.length) return [];

  const values = [];

  for (const row of rows) {
    const firstColumn = row.split(',')[0]?.trim();
    if (!firstColumn) continue;
    values.push(firstColumn);
  }

  return values;
};

const getIstHour = () => {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hour12: false
  }).format(new Date());

  return Number.parseInt(formatted, 10);
};

const isWithinTraiWindow = () => {
  const hour = getIstHour();
  return Number.isFinite(hour) && hour >= 9 && hour < 21;
};

const buildMetrics = (initiated, failed, total) => ({
  initiated,
  failed,
  total,
  successRate: total > 0 ? Math.round((initiated / total) * 100) : 0
});

const getTodayWindow = () => {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

class OutboundLocalController {
  constructor() {
    this.outboundAudioCache = new Map();
  }

  async runWithTimeout(taskPromise, timeoutMs, timeoutErrorMessage = 'Operation timed out') {
    const timeout = Number(timeoutMs || 0);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return taskPromise;
    }

    let timer = null;
    try {
      return await Promise.race([
        taskPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(timeoutErrorMessage)), timeout);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  buildSerializableTwilioCall(call = {}) {
    return {
      sid: String(call?.sid || ''),
      status: String(call?.status || ''),
      to: String(call?.to || ''),
      from: String(call?.from || ''),
      direction: String(call?.direction || ''),
      dateCreated: call?.dateCreated || null,
      startTime: call?.startTime || null,
      endTime: call?.endTime || null,
      price: call?.price ?? null,
      priceUnit: call?.priceUnit || null
    };
  }

  getTwilioCredentialField(credentials = {}, names = []) {
    for (const key of names) {
      const value = String(credentials?.[key] || '').trim();
      if (value) return value;
    }
    return '';
  }

  async resolveTwilioContext({ userId = '', from = '' }) {
    const byUser = await adminCredentialsService.getTwilioCredentialsByUserId(userId);
    const byPhone = from ? await adminCredentialsService.getTwilioCredentialsByPhoneNumber(from) : null;
    const merged = { ...(byUser || {}), ...(byPhone || {}) };

    const accountSid = this.getTwilioCredentialField(merged, [
      'twilioAccountSid',
      'accountSid',
      'sid',
      'TWILIO_ACCOUNT_SID'
    ]);
    const authToken = this.getTwilioCredentialField(merged, [
      'twilioAuthToken',
      'authToken',
      'token',
      'TWILIO_AUTH_TOKEN'
    ]);
    const phoneNumber = this.getTwilioCredentialField(merged, [
      'twilioPhoneNumber',
      'phoneNumber',
      'fromNumber',
      'TWILIO_PHONE_NUMBER'
    ]);

    if (!accountSid || !authToken) {
      throw new Error('Twilio credentials not found for this user. Please configure Twilio credentials in admin settings.');
    }

    return {
      accountSid,
      authToken,
      phoneNumber
    };
  }

  buildTwilioTwiML({ audioUrl = '', script = '' }) {
    const escapeXml = (value = '') =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    let xmlBody = '<?xml version="1.0" encoding="UTF-8"?><Response>';
    if (audioUrl) {
      xmlBody += `<Play>${escapeXml(audioUrl)}</Play>`;
    } else if (script) {
      xmlBody += `<Say voice="alice" language="en-IN">${escapeXml(script)}</Say>`;
    } else {
      xmlBody += '<Say voice="alice" language="en-IN">Thank you. Please stay on the line.</Say>';
    }
    xmlBody += '<Hangup/></Response>';
    return xmlBody;
  }

  buildTwilioIntroRedirectTwiML({ audioUrl = '', script = '', redirectUrl = '' }) {
    const escapeXml = (value = '') =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    let xmlBody = '<?xml version="1.0" encoding="UTF-8"?><Response>';
    if (audioUrl) {
      xmlBody += `<Play>${escapeXml(audioUrl)}</Play>`;
    } else if (script) {
      xmlBody += `<Say voice="alice" language="en-IN">${escapeXml(script)}</Say>`;
    }
    xmlBody += `<Redirect method="POST">${escapeXml(redirectUrl)}</Redirect>`;
    xmlBody += '</Response>';
    return xmlBody;
  }

  async resolveScriptAudioAsset({ script = '', userObjectId = null, voice = 'en-GB-SoniaNeural', language = 'en-GB' }) {
    const text = String(script || '').trim();
    if (!text) {
      return { audioUrl: '', audioAssetId: '', storage: 'none' };
    }

    try {
      const userKey = String(userObjectId || 'anonymous');
      const hash = crypto.createHash('sha1').update(`${userKey}|${voice}|${language}|${text}`).digest('hex');
      const cacheKey = `${userKey}:${voice}:${language}:${hash}`;
      const cached = this.outboundAudioCache.get(cacheKey);
      if (cached?.audioUrl) {
        return cached;
      }

      if (!process.env.CLOUDINARY_CLOUD_NAME) {
        logger.warn('Cloudinary is not configured; skipping outbound local audio file generation.');
        return { audioUrl: '', audioAssetId: '', storage: 'none' };
      }

      const audioData = await pythonTTSService.getAudioForPrompt(
        `outbound_local_${hash}`,
        text,
        language,
        voice,
        null,
        { id: `outbound_${hash}`, type: 'outbound' },
        { userId: String(userObjectId || ''), username: '' }
      );

      const result = {
        audioUrl: String(audioData?.audioUrl || '').trim(),
        audioAssetId: String(audioData?.publicId || '').trim(),
        storage: 'cloudinary'
      };
      if (result.audioUrl) {
        this.outboundAudioCache.set(cacheKey, result);
        return result;
      }

      return { audioUrl: '', audioAssetId: '', storage: 'none' };
    } catch (error) {
      logger.error('Failed to generate outbound local script audio URL:', error);
      return { audioUrl: '', audioAssetId: '', storage: 'none' };
    }
  }

  async persistCallRecord({
    userObjectId,
    to,
    exotelResult = null,
    from,
    provider = 'exotel',
    status = 'initiated',
    providerData = {},
    errorMessage = ''
  }) {
    const callSid = exotelResult?.callSid || `failed_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const normalizedProvider = provider === 'twilio' ? 'twilio' : 'exotel';
    const webhookUrl =
      normalizedProvider === 'twilio'
        ? `${String(process.env.BASE_URL || '').replace(/\/$/, '')}/webhook/twilio/status`
        : `${String(process.env.BASE_URL || '').replace(/\/$/, '')}/webhook/ivr`;

    const providerPayload =
      normalizedProvider === 'exotel'
        ? { exotel: exotelResult?.raw || {} }
        : { twilio: exotelResult?.raw || {} };

    const providerDataPayload = {
      from,
      webhookUrl,
      ...(providerData || {}),
      ...providerPayload
    };

    const call = await Call.create({
      callSid,
      exotelCallSid: normalizedProvider === 'exotel' ? (exotelResult?.callSid || '') : '',
      user: userObjectId,
      phoneNumber: to,
      direction: 'outbound-local',
      provider: normalizedProvider,
      status,
      retryAttempt: 0,
      nextRetryAt: status === 'failed' ? new Date(Date.now() + 2 * 60 * 60 * 1000) : null,
      startTime: new Date(),
      providerData: providerDataPayload,
      error: errorMessage ? { message: errorMessage } : undefined
    });

    emitOutboundCallUpdate(String(userObjectId || ''), {
      _id: String(call._id || ''),
      callSid: call.callSid,
      phoneNumber: call.phoneNumber,
      status: call.status,
      direction: call.direction,
      provider: call.provider,
      duration: call.duration || 0,
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
      providerData: providerDataPayload
    });

    return call;
  }

  async quickCall(req, res) {
    try {
      const userId = getUserIdString(req);
      const userObjectId = getUserObjectId(req);
      const provider = String(req.body?.provider || 'exotel').trim().toLowerCase();
      const scheduleType = String(req.body?.scheduleType || 'immediate').trim().toLowerCase();
      const workflowId = String(req.body?.workflowId || '').trim();
      const scheduledAt = req.body?.scheduledAt || null;
      const from =
        provider === 'exotel'
          ? String(req.body?.from || process.env.EXOTEL_NUMBER || '').trim()
          : String(req.body?.from || '').trim();
      const toRaw = String(req.body?.to || '').trim();
      const to = normalizeLocalNumber(toRaw);
      const templateId = String(req.body?.templateId || '').trim();
      const customMessage = String(req.body?.customMessage || '').trim();
      let resolvedTemplateName = '';
      let resolvedScript = customMessage;

      if (!userId || !userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      if (!['exotel', 'twilio'].includes(provider)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid provider. Supported providers are exotel and twilio.'
        });
      }

      if (provider === 'exotel' && !LOCAL_MOBILE_REGEX.test(from)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid From number. Expected +91XXXXXXXXXX format.'
        });
      }

      if (provider === 'exotel' && (!to || !LOCAL_MOBILE_REGEX.test(to))) {
        return res.status(400).json({
          success: false,
          message: 'Invalid To number. Expected +91 followed by a valid supported mobile number.'
        });
      }

      const normalizedToTwilio = normalizeLocalNumber(toRaw);
      if (provider === 'twilio' && (!normalizedToTwilio || !LOCAL_MOBILE_REGEX.test(normalizedToTwilio))) {
        return res.status(400).json({
          success: false,
          message: 'Invalid To number. Use a valid supported mobile number (+91XXXXXXXXXX).'
        });
      }

      if (templateId) {
        if (!mongoose.Types.ObjectId.isValid(templateId)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid template id'
          });
        }

        const template = await OutboundLocalTemplate.findOne({
          _id: templateId,
          createdBy: userObjectId,
          isActive: true
        }).lean();

        if (!template) {
          return res.status(404).json({
            success: false,
            message: 'Template not found'
          });
        }

        resolvedTemplateName = template.name;
        if (!resolvedScript) {
          resolvedScript = String(template.script || '').trim();
        }
      }

      if (scheduleType !== 'immediate') {
        const campaign = await outboundCampaignService.createCampaign({
          provider,
          originType: 'single',
          campaignType: 'single',
          campaignName: `Single Call ${to || toRaw || Date.now()}`,
          from,
          templateId: templateId || '',
          customMessage: resolvedScript || customMessage,
          voiceId: String(req.body?.voiceId || req.body?.voice || 'en-GB-SoniaNeural').trim(),
          voice: String(req.body?.voice || req.body?.voiceId || 'en-GB-SoniaNeural').trim(),
          workflowId,
          scheduleType,
          scheduledAt,
          recurrence: String(req.body?.recurrence || 'none').trim().toLowerCase(),
          timezone: String(req.body?.timezone || 'Asia/Kolkata').trim(),
          allowedWindowStart: String(req.body?.allowedWindowStart || '09:00').trim(),
          allowedWindowEnd: String(req.body?.allowedWindowEnd || '21:00').trim(),
          contacts: [{ phone: to || toRaw, name: 'Single Call Contact', customFields: {} }],
          csvData: ''
        }, userObjectId, {
          autoExecute: false,
          createSchedule: true
        });

        return res.status(200).json({
          success: true,
          scheduled: true,
          campaignId: campaign.campaignId,
          campaignDbId: campaign._id,
          campaignType: 'single',
          originType: 'single',
          phoneNumber: to || toRaw,
          status: campaign.status,
          schedule: campaign.schedule
        });
      }

      if (provider === 'exotel' && !isWithinTraiWindow()) {
        return res.status(403).json({
          success: false,
          message: 'Outbound calls are allowed only between 9:00 AM and 9:00 PM IST as per TRAI guidelines.'
        });
      }

      let resolvedAudio = { audioUrl: '', audioAssetId: '', storage: 'none' };
      const quickCallTtsTimeoutMs = Number(process.env.OUTBOUND_QUICKCALL_TTS_TIMEOUT_MS || 12000);
      try {
        resolvedAudio = await this.runWithTimeout(
          this.resolveScriptAudioAsset({
            script: resolvedScript,
            userObjectId
          }),
          quickCallTtsTimeoutMs,
          `Quick call TTS timed out after ${quickCallTtsTimeoutMs}ms`
        );
      } catch (ttsTimeoutError) {
        logger.warn('Quick call TTS unavailable; falling back to Say playback.', {
          message: ttsTimeoutError.message
        });
      }
      const resolvedAudioUrl = String(resolvedAudio?.audioUrl || '').trim();

      let providerResult = null;
      let persistedTo = to;
      let persistedFrom = from;
      const resolvedWorkflow = workflowId
        ? await outboundCampaignService.resolveWorkflow(workflowId, userObjectId)
        : null;

      if (provider === 'twilio') {
        const twilioContext = await this.resolveTwilioContext({ userId, from });
        const twilioFrom = String(from || twilioContext.phoneNumber || '').trim();
        if (!E164_REGEX.test(twilioFrom)) {
          return res.status(400).json({
            success: false,
            message: 'Twilio From number not configured. Provide a valid E.164 From number or configure Twilio phone number in admin settings.'
          });
        }

        const baseUrl = String(process.env.BASE_URL || '').replace(/\/$/, '');

        const client = twilio(twilioContext.accountSid, twilioContext.authToken);
        const callPayload = {
          to: normalizedToTwilio,
          from: twilioFrom,
          timeout: 25
        };

        if (resolvedWorkflow && !baseUrl) {
          return res.status(400).json({
            success: false,
            message: 'BASE_URL is required for Twilio outbound IVR callbacks. Configure a public backend URL before launching an IVR call.'
          });
        }

        if (resolvedWorkflow && baseUrl) {
          const workflowStartUrl = `${baseUrl}/webhook/outbound-local/workflow/start/${resolvedWorkflow.workflowId}?userId=${encodeURIComponent(String(userObjectId))}`;
          if (resolvedAudioUrl || resolvedScript) {
            callPayload.twiml = this.buildTwilioIntroRedirectTwiML({
              audioUrl: resolvedAudioUrl || '',
              script: resolvedScript || '',
              redirectUrl: workflowStartUrl
            });
          } else {
            callPayload.url = workflowStartUrl;
            callPayload.method = 'POST';
          }
        } else {
          const twiml = this.buildTwilioTwiML({
            audioUrl: resolvedAudioUrl || '',
            script: resolvedScript || ''
          });
          callPayload.twiml = twiml;
        }

        if (baseUrl) {
          callPayload.statusCallback = `${baseUrl}/webhook/twilio/status`;
          callPayload.statusCallbackMethod = 'POST';
          callPayload.statusCallbackEvent = ['initiated', 'ringing', 'answered', 'completed'];
        } else {
          logger.warn('BASE_URL missing; Twilio status callbacks are disabled for this quick call.');
        }

        const call = await client.calls.create(callPayload);

        providerResult = {
          callSid: call.sid,
          status: String(call.status || 'initiated').toLowerCase(),
          raw: this.buildSerializableTwilioCall(call)
        };
        persistedTo = normalizedToTwilio;
        persistedFrom = twilioFrom;
      } else {
        providerResult = await exotelService.createOutboundLocalCall({
          to,
          from,
          appParams: {
            script: resolvedScript || '',
            audioUrl: resolvedAudioUrl || '',
            templateId: templateId || '',
            templateName: resolvedTemplateName || '',
            workflowId: resolvedWorkflow?.workflowId ? String(resolvedWorkflow.workflowId) : '',
            startNodeId: resolvedWorkflow?.startNodeId || '',
            userId: String(userObjectId)
          }
        });
        persistedTo = to;
        persistedFrom = from;
      }

      await this.persistCallRecord({
        userObjectId,
        to: persistedTo,
        exotelResult: providerResult,
        from: persistedFrom,
        provider,
        providerData: {
          provider,
          originType: 'single',
          campaignType: 'single',
          singleRecipient: persistedTo,
          contactCount: 1,
          templateId: templateId || '',
          templateName: resolvedTemplateName || '',
          script: resolvedScript || '',
          audioUrl: resolvedAudioUrl || '',
          workflowId: resolvedWorkflow?.workflowId ? String(resolvedWorkflow.workflowId) : '',
          workflowName: resolvedWorkflow?.workflowName || '',
          audioAssetId: String(resolvedAudio?.audioAssetId || ''),
          audioStorage: String(resolvedAudio?.storage || 'none'),
          ttsMode: resolvedAudioUrl ? 'audio_url' : 'say_fallback'
        }
      });

      emitOutboundMetrics(userId, {
        mode: 'quick',
        provider,
        ...buildMetrics(1, 0, 1)
      });

      reportUsage({
        companyId: req.user?.companyId,
        userId,
        usageType: 'voice_call',
        count: 1
      });

      return res.status(200).json({
        success: true,
        callSid: providerResult.callSid,
        status: 'initiated',
        provider,
        templateId: templateId || '',
        templateName: resolvedTemplateName || '',
        audioUrl: resolvedAudioUrl || '',
        audioAssetId: String(resolvedAudio?.audioAssetId || ''),
        audioStorage: String(resolvedAudio?.storage || 'none'),
        ttsMode: resolvedAudioUrl ? 'audio_url' : 'say_fallback'
      });
    } catch (error) {
      logger.error('Outbound Local quick call failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to initiate outbound local call',
        error: error.message
      });
    }
  }

  async overview(req, res) {
    try {
      const userId = getUserIdString(req);
      const userObjectId = getUserObjectId(req);
      if (!userId || !userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const { start: todayStart, end: todayEnd } = getTodayWindow();
      const last24HoursStart = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [todayCalls, last24HourCalls, recentCalls] = await Promise.all([
        Call.find({
          user: userObjectId,
          direction: 'outbound-local',
          deletedAt: null,
          createdAt: { $gte: todayStart, $lte: todayEnd }
        })
          .select('status')
          .lean(),
        Call.find({
          user: userObjectId,
          direction: 'outbound-local',
          deletedAt: null,
          createdAt: { $gte: last24HoursStart }
        })
          .select('status')
          .lean(),
        Call.find({
          user: userObjectId,
          direction: 'outbound-local',
          deletedAt: null
        })
          .sort({ createdAt: -1 })
          .limit(15)
          .select('callSid phoneNumber status duration createdAt providerData')
          .lean()
      ]);

      const summarize = (calls = []) => {
        const total = calls.length;
        const initiated = calls.filter((call) =>
          ['initiated', 'ringing', 'in-progress', 'completed'].includes(String(call?.status || '').toLowerCase())
        ).length;
        const failed = calls.filter((call) =>
          ['failed', 'busy', 'no-answer'].includes(String(call?.status || '').toLowerCase())
        ).length;
        return buildMetrics(initiated, failed, total);
      };

      return res.status(200).json({
        success: true,
        trai: {
          isTraiAllowedNow: isWithinTraiWindow(),
          timezone: 'Asia/Kolkata',
          allowedHours: '09:00-21:00'
        },
        today: summarize(todayCalls),
        last24Hours: summarize(last24HourCalls),
        recentCalls: recentCalls.map((call) => ({
          callSid: call.callSid,
          phoneNumber: call.phoneNumber,
          status: call.status,
          duration: call.duration || 0,
          createdAt: call.createdAt,
          campaignId: call?.providerData?.campaignId || '',
          campaignName: call?.providerData?.campaignName || ''
        }))
      });
    } catch (error) {
      logger.error('Outbound Local overview failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch outbound local overview',
        error: error.message
      });
    }
  }

  async bulkCampaigns(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const campaign = await outboundCampaignService.createCampaign({
        ...(req.body || {}),
        originType: req.body?.originType || req.body?.campaignType || 'bulk',
        campaignType: req.body?.campaignType || req.body?.originType || 'bulk'
      }, userObjectId, {
        autoExecute: true,
        createSchedule: true
      });

      const bulkNumbersCount = Array.isArray(req.body?.numbers) && req.body.numbers.length > 0
        ? req.body.numbers.length
        : String(req.body?.csvData || req.body?.csv || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean).length;

      reportUsage({
        companyId: req.user?.companyId,
        userId: getUserIdString(req),
        usageType: 'voice_call',
        count: bulkNumbersCount > 0 ? bulkNumbersCount : 1
      });

      return res.status(200).json({
        success: true,
        campaignId: campaign.campaignId,
        campaignDbId: campaign._id,
        campaignType: campaign.metadata?.originType || 'bulk',
        originType: campaign.metadata?.originType || 'bulk',
        status: campaign.status,
        schedule: campaign.schedule,
        message: campaign.schedule?.enabled
          ? 'Bulk campaign created and scheduled successfully.'
          : 'Bulk campaign created and launched successfully.'
      });
    } catch (error) {
      logger.error('Outbound Local bulk campaign failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to start outbound local bulk campaign',
        error: error.message
      });
    }
  }

  async listCampaigns(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const data = await outboundCampaignService.listCampaigns(userObjectId, req.query || {});
      return res.status(200).json({
        success: true,
        campaigns: data.items,
        pagination: data.pagination
      });
    } catch (error) {
      logger.error('Outbound campaign listing failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch outbound campaigns',
        error: error.message
      });
    }
  }

  async listTemplates(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const templates = await OutboundLocalTemplate.find({
        createdBy: userObjectId,
        isActive: true
      })
        .sort({ updatedAt: -1 })
        .select('_id name script updatedAt createdAt')
        .lean();

      return res.status(200).json({
        success: true,
        templates
      });
    } catch (error) {
      logger.error('Outbound Local template listing failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch outbound templates',
        error: error.message
      });
    }
  }

  async createTemplate(req, res) {
    try {
      const userId = getUserIdString(req);
      const userObjectId = getUserObjectId(req);
      if (!userId || !userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const name = String(req.body?.name || '').trim();
      const script = String(req.body?.script || '').trim();

      if (!name || name.length < 2 || name.length > 80) {
        return res.status(400).json({
          success: false,
          message: 'Template name must be between 2 and 80 characters.'
        });
      }

      if (!script || script.length > 1000) {
        return res.status(400).json({
          success: false,
          message: 'Template script is required and must be at most 1000 characters.'
        });
      }

      const existing = await OutboundLocalTemplate.findOne({
        createdBy: userObjectId,
        isActive: true,
        name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
      }).lean();

      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Template with same name already exists.'
        });
      }

      const created = await OutboundLocalTemplate.create({
        name,
        script,
        createdBy: userObjectId
      });

      emitOutboundTemplateUpdate(userId, {
        action: 'created',
        template: {
          _id: created._id,
          name: created.name,
          script: created.script,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt
        }
      });

      return res.status(201).json({
        success: true,
        template: {
          _id: created._id,
          name: created.name,
          script: created.script,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt
        }
      });
    } catch (error) {
      logger.error('Outbound Local template creation failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to create outbound template',
        error: error.message
      });
    }
  }

  async deleteTemplate(req, res) {
    try {
      const userId = getUserIdString(req);
      const userObjectId = getUserObjectId(req);
      const templateId = String(req.params?.templateId || '').trim();

      if (!userId || !userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      if (!mongoose.Types.ObjectId.isValid(templateId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid template id'
        });
      }

      const deleted = await OutboundLocalTemplate.findOneAndUpdate(
        { _id: templateId, createdBy: userObjectId, isActive: true },
        { $set: { isActive: false } },
        { new: true }
      ).lean();

      if (!deleted) {
        return res.status(404).json({
          success: false,
          message: 'Template not found'
        });
      }

      emitOutboundTemplateUpdate(userId, {
        action: 'deleted',
        templateId
      });

      return res.status(200).json({
        success: true,
        templateId,
        deletedAt: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Outbound Local template deletion failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to delete outbound template',
        error: error.message
      });
    }
  }

  async updateTemplate(req, res) {
    try {
      const userId = getUserIdString(req);
      const userObjectId = getUserObjectId(req);
      const templateId = String(req.params?.templateId || '').trim();
      const name = String(req.body?.name || '').trim();
      const script = String(req.body?.script || '').trim();

      if (!userId || !userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      if (!mongoose.Types.ObjectId.isValid(templateId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid template id'
        });
      }

      if (!name || name.length < 2 || name.length > 80) {
        return res.status(400).json({
          success: false,
          message: 'Template name must be between 2 and 80 characters.'
        });
      }

      if (!script || script.length > 1000) {
        return res.status(400).json({
          success: false,
          message: 'Template script is required and must be at most 1000 characters.'
        });
      }

      const existing = await OutboundLocalTemplate.findOne({
        _id: { $ne: templateId },
        createdBy: userObjectId,
        isActive: true,
        name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
      }).lean();

      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Template with same name already exists.'
        });
      }

      const updated = await OutboundLocalTemplate.findOneAndUpdate(
        { _id: templateId, createdBy: userObjectId, isActive: true },
        { $set: { name, script } },
        { new: true }
      ).lean();

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: 'Template not found'
        });
      }

      emitOutboundTemplateUpdate(userId, {
        action: 'updated',
        template: {
          _id: updated._id,
          name: updated.name,
          script: updated.script,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt
        }
      });

      return res.status(200).json({
        success: true,
        template: {
          _id: updated._id,
          name: updated.name,
          script: updated.script,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt
        }
      });
    } catch (error) {
      logger.error('Outbound Local template update failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to update outbound template',
        error: error.message
      });
    }
  }

  async deleteCampaigns(req, res) {
    try {
      const userObjectId = getUserObjectId(req);
      if (!userObjectId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const campaignIds = Array.isArray(req.body?.campaignIds) ? req.body.campaignIds : [];
      const validIds = campaignIds
        .map((id) => String(id))
        .filter((id) => mongoose.Types.ObjectId.isValid(id));

      if (!validIds.length) {
        return res.status(400).json({ success: false, message: 'campaignIds must be a non-empty array' });
      }

      const campaigns = await OutboundCampaign.find({
        _id: { $in: validIds },
        userId: userObjectId
      }).select('_id').lean();

      const scopedIds = campaigns.map((item) => item._id);
      if (!scopedIds.length) {
        return res.status(404).json({ success: false, message: 'No campaigns found to delete' });
      }

      await OutboundCampaignContact.deleteMany({ campaignId: { $in: scopedIds } });
      const result = await OutboundCampaign.deleteMany({ _id: { $in: scopedIds } });

      return res.status(200).json({
        success: true,
        deletedCount: result.deletedCount || 0
      });
    } catch (error) {
      logger.error('Outbound Local campaign bulk delete failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to delete outbound campaigns',
        error: error.message
      });
    }
  }
}

export default new OutboundLocalController();

