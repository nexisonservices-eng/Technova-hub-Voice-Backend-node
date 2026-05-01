import express from 'express';
import Call from '../models/call.js';
import logger from '../utils/logger.js';
import IVRController from '../controllers/ivrController.js';
import outboundCampaignService from '../services/outboundCampaignService.js';
import Workflow from '../models/Workflow.js';
import ivrWorkflowEngine from '../services/ivrWorkflowEngine.js';
import { verifyTwilioRequest } from '../middleware/twilioAuth.js';
import { emitOutboundCallUpdate } from '../sockets/unifiedSocket.js';

const router = express.Router();
const ivrController = new IVRController();

const escapeXml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const mapExotelStatus = (status = '') => {
  const normalized = String(status || '').trim().toLowerCase();
  if (['in-progress', 'inprogress', 'ongoing'].includes(normalized)) return 'in-progress';
  if (['completed', 'complete'].includes(normalized)) return 'completed';
  if (['busy'].includes(normalized)) return 'busy';
  if (['no-answer', 'noanswer', 'unanswered'].includes(normalized)) return 'no-answer';
  if (['failed', 'error'].includes(normalized)) return 'failed';
  if (['ringing'].includes(normalized)) return 'ringing';
  if (['initiated', 'queued', 'new'].includes(normalized)) return 'initiated';
  return '';
};

const TERMINAL_OUTBOUND_STATUSES = new Set(['completed', 'failed', 'busy', 'no-answer', 'cancelled', 'canceled']);

const buildOutboundCallPayload = (call, status, duration = 0) => {
  const providerData = call?.providerData || {};
  const updatedAt = call?.updatedAt || new Date();
  return {
    _id: call?._id,
    callSid: call?.callSid || '',
    status,
    phoneNumber: call?.phoneNumber || '',
    provider: call?.provider || providerData.provider || '',
    duration: Number(call?.duration || duration || 0),
    campaignId: providerData.campaignId || '',
    campaignDbId: providerData.campaignDbId || '',
    campaignName: providerData.campaignName || '',
    contactId: providerData.contactId || '',
    workflowId: providerData.workflowId || '',
    voiceId: providerData.voiceId || '',
    createdAt: call?.createdAt || updatedAt,
    updatedAt,
    ended: TERMINAL_OUTBOUND_STATUSES.has(String(status || '').toLowerCase())
  };
};

const rewriteWorkflowUrls = (xml = '') =>
  String(xml || '')
    .replace(/\/ivr\/handle-input/g, '/webhook/outbound-local/workflow/handle-input')
    .replace(/\/ivr\/next-step/g, '/webhook/outbound-local/workflow/next-step');

const sendWorkflowResponse = (res, xml = '') =>
  res.status(200).type('text/xml').send(rewriteWorkflowUrls(xml));

const extractResponseInnerXml = (xml = '') => {
  const withoutDeclaration = String(xml || '').replace(/^\s*<\?xml[^>]*>\s*/i, '');
  const match = withoutDeclaration.match(/^\s*<Response[^>]*>([\s\S]*?)<\/Response>\s*$/i);
  return match ? match[1] : withoutDeclaration;
};

const buildIntroWorkflowXml = ({ audioUrl = '', script = '', workflowXml = '' }) => {
  let xmlBody = '<?xml version="1.0" encoding="UTF-8"?><Response>';
  if (audioUrl) {
    xmlBody += `<Play>${escapeXml(audioUrl)}</Play>`;
  } else if (script) {
    xmlBody += `<Say>${escapeXml(script)}</Say>`;
  }
  xmlBody += extractResponseInnerXml(workflowXml);
  xmlBody += '</Response>';
  return xmlBody;
};

router.post('/outbound-local/workflow/start/:workflowId', verifyTwilioRequest, async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { CallSid, From, To } = req.body || {};
    const workflow = await Workflow.findById(workflowId).select('_id promptKey nodes createdBy');
    if (!workflow) {
      return res.status(404).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Workflow not found.</Say><Hangup/></Response>');
    }

    const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
    const startNode = nodes.find((node) => node.type === 'greeting' || node.type === 'audio') || nodes[0];
    if (!startNode?.id) {
      return res.status(400).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Workflow start node missing.</Say><Hangup/></Response>');
    }

    await ivrWorkflowEngine.startExecution(workflow._id, CallSid, From, To, workflow.createdBy || null);
    await outboundCampaignService.annotateExecution(CallSid, {
      campaignId: String(req.query?.campaignId || ''),
      campaignContactId: String(req.query?.contactId || ''),
      trigger: 'outbound_campaign'
    });
    const twiml = await ivrWorkflowEngine.generateTwiML(workflow._id, startNode.id, null, CallSid);
    return sendWorkflowResponse(res, twiml);
  } catch (error) {
    logger.error('Outbound workflow start failed:', error);
    return res.status(500).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unable to continue the call.</Say><Hangup/></Response>');
  }
});

router.post('/outbound-local/workflow/handle-input', verifyTwilioRequest, async (req, res) => {
  try {
    await ivrController.handleInput(req, {
      type: () => {},
      send: (xml) => sendWorkflowResponse(res, xml)
    });
  } catch (error) {
    logger.error('Outbound workflow input failed:', error);
    return res.status(500).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unable to process your input.</Say><Hangup/></Response>');
  }
});

router.post('/outbound-local/workflow/next-step', verifyTwilioRequest, async (req, res) => {
  try {
    await ivrController.nextStep(req, {
      type: () => {},
      send: (xml) => sendWorkflowResponse(res, xml)
    });
  } catch (error) {
    logger.error('Outbound workflow next-step failed:', error);
    return res.status(500).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unable to continue the call.</Say><Hangup/></Response>');
  }
});

router.all('/ivr', async (req, res) => {
  try {
    const payload = req.body || {};
    const exotelCallSid = String(
      payload.CallSid ||
      payload.CallUUID ||
      payload.CallId ||
      payload.sid ||
      ''
    ).trim();
    const exotelStatus = mapExotelStatus(
      payload.Status ||
      payload.CallStatus ||
      payload.status ||
      payload.call_status
    );
    const durationRaw = Number(payload.Duration || payload.CallDuration || 0);
    const duration = Number.isFinite(durationRaw) ? Math.max(0, durationRaw) : 0;

    let customField = payload.CustomField || payload.customField || '{}';
    if (typeof customField !== 'string') {
      customField = JSON.stringify(customField || {});
    }

    let customData = {};
    try {
      customData = customField ? JSON.parse(customField) : {};
    } catch {
      customData = {};
    }

    let script = String(customData?.script || '').trim();
    let audioUrl = String(customData?.audioUrl || '').trim();
    const workflowId = String(customData?.workflowId || '').trim();
    const startNodeId = String(customData?.startNodeId || '').trim();

    let callDoc = null;
    if (exotelCallSid && (!script || !audioUrl || exotelStatus)) {
      callDoc = await Call.findOne({
        $or: [{ exotelCallSid }, { callSid: exotelCallSid }],
        provider: 'exotel',
        direction: 'outbound-local',
        deletedAt: null
      }).select('callSid user phoneNumber provider providerData status duration endTime createdAt updatedAt');

      if (callDoc) {
        if (!script) {
          script = String(callDoc?.providerData?.script || '').trim();
        }
        if (!audioUrl) {
          audioUrl = String(callDoc?.providerData?.audioUrl || '').trim();
        }

        if (exotelStatus) {
          callDoc.status = exotelStatus;
          if (duration > 0) {
            callDoc.duration = duration;
          }
          if (['completed', 'failed', 'busy', 'no-answer'].includes(exotelStatus)) {
            callDoc.endTime = new Date();
          }
          await callDoc.save();
          emitOutboundCallUpdate(String(callDoc.user || ''), buildOutboundCallPayload(callDoc, exotelStatus, duration));
          await outboundCampaignService.syncCallUpdate(exotelCallSid, exotelStatus, duration);
        }
      }
    }

    if (workflowId && exotelCallSid) {
      if (!callDoc) {
        callDoc = await Call.findOne({
          $or: [{ exotelCallSid }, { callSid: exotelCallSid }],
          provider: 'exotel',
          direction: 'outbound-local',
          deletedAt: null
        }).select('callSid user phoneNumber provider providerData status duration endTime createdAt updatedAt');
      }

      const digits = String(payload.Digits || payload.digits || '').trim();
      const statusBody = exotelStatus === 'completed' ? { CallSid: exotelCallSid, CallStatus: 'completed' } : null;
      if (statusBody) {
        await ivrController.handleCallStatus({ body: statusBody }, { sendStatus: () => {} });
      }

      if (digits && startNodeId) {
        return await ivrController.handleInput(
          {
            body: { CallSid: exotelCallSid, Digits: digits },
            query: { workflowId, currentNodeId: startNodeId }
          },
          {
            type: () => {},
            send: (xml) => sendWorkflowResponse(res, xml)
          }
        );
      }

      if (startNodeId) {
        const xml = await ivrWorkflowEngine.generateTwiML(workflowId, startNodeId, null, exotelCallSid);
        if (xml) {
          const introAlreadyPlayed = Boolean(callDoc?.providerData?.ivrIntroPlayedAt || customData?.introPlayed);
          const hasIntroMessage = Boolean(audioUrl || script);
          if (!introAlreadyPlayed && hasIntroMessage) {
            if (callDoc) {
              callDoc.providerData = {
                ...(callDoc.providerData || {}),
                ivrIntroPlayedAt: new Date()
              };
              callDoc.markModified('providerData');
              await callDoc.save();
            }
            return sendWorkflowResponse(res, buildIntroWorkflowXml({
              audioUrl,
              script,
              workflowXml: xml
            }));
          }
          return sendWorkflowResponse(res, xml);
        }
      }
    }

    let xmlBody = '<?xml version="1.0" encoding="UTF-8"?><Response>';
    if (audioUrl) {
      xmlBody += `<Play>${escapeXml(audioUrl)}</Play>`;
      xmlBody += '<Hangup/>';
    } else if (script) {
      xmlBody += `<Say>${escapeXml(script)}</Say>`;
      xmlBody += '<Hangup/>';
    } else {
      xmlBody += '<Say>Thank you. Please stay on the line.</Say><Hangup/>';
    }
    xmlBody += '</Response>';

    return res.status(200).type('text/xml').send(xmlBody);
  } catch (error) {
    logger.error('Exotel /webhook/ivr handler failed:', error);
    const fallback = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>We are unable to process your call right now.</Say><Hangup/></Response>';
    return res.status(200).type('text/xml').send(fallback);
  }
});

export default router;

