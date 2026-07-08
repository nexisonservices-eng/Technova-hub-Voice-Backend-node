import crypto from 'crypto';
import logger from '../utils/logger.js';
import BookingSlot from '../models/BookingSlot.js';
import AppointmentBooking from '../models/AppointmentBooking.js';
import BookingNotificationLog from '../models/BookingNotificationLog.js';
import whatsappNotificationBridge from './whatsappNotificationBridge.js';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const toTrimmedString = (value) => String(value ?? '').trim();
const toPositiveInt = (value, fallback = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const buildSequentialVariables = (values = []) =>
  values.map((value) => toTrimmedString(value));

const templateValue = (value, fallback = 'N/A') => {
  const normalized = toTrimmedString(value);
  return normalized || fallback;
};

const normalizeErrorMessage = (value, fallback = 'Unknown WhatsApp error') => {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === 'object') {
    return (
      value.message ||
      value.error_user_msg ||
      value.error_user_title ||
      value.details ||
      value.error ||
      (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return fallback;
        }
      })()
    );
  }
  return String(value || fallback);
};

const normalizeSlotObject = (slot, index = 0) => {
  const raw = slot && typeof slot === 'object' ? slot : {};
  const key = toTrimmedString(raw.key || raw.slotKey || raw.id || raw.digit || raw.value || `slot_${index + 1}`);
  const label = toTrimmedString(raw.label || raw.title || raw.timeLabel || raw.name || raw.startTime || raw.start || key);
  const startTime = toTrimmedString(raw.startTime || raw.start || raw.from || '');
  const endTime = toTrimmedString(raw.endTime || raw.end || raw.to || '');
  const capacity = toPositiveInt(raw.capacity || raw.limit || raw.maxMembers || raw.maxCapacity, 1);
  const active = raw.active === false ? false : true;
  const digit = toTrimmedString(raw.digit || raw.option || raw.choice || String(index + 1));
  const order = Number.isFinite(Number(raw.order)) ? Number(raw.order) : index + 1;
  const template = raw.template && typeof raw.template === 'object' ? raw.template : {};

  return {
    key,
    label,
    startTime,
    endTime,
    capacity,
    active,
    digit,
    order,
    metadata: {
      ...raw,
      template
    }
  };
};

const normalizeSlotList = (slotDefinitions) => {
  const list = Array.isArray(slotDefinitions)
    ? slotDefinitions
    : (() => {
        if (typeof slotDefinitions !== 'string') return [];
        const trimmed = slotDefinitions.trim();
        if (!trimmed) return [];
        try {
          const parsed = JSON.parse(trimmed);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();

  return list
    .map((slot, index) => normalizeSlotObject(slot, index))
    .filter((slot) => slot.key && slot.label);
};

const toDateKey = (date = new Date(), timezone = DEFAULT_TIMEZONE) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || DEFAULT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(date);
  }
};

const toDisplayCount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

class AppointmentBookingService {
  getWorkflowTimezone(node = {}, workflow = {}) {
    return (
      toTrimmedString(node?.data?.timezone || node?.data?.slotTimezone || workflow?.settings?.timezone || workflow?.config?.timezone) ||
      DEFAULT_TIMEZONE
    );
  }

  getSlotDefinitions(node = {}) {
    const data = node?.data || {};
    return normalizeSlotList(
      data.slotDefinitions ??
      data.slot_definitions ??
      data.slotDefinitionsText ??
      data.slot_definitions_text ??
      data.slots ??
      data.slotOptions ??
      []
    );
  }

  getDateKey(node = {}, workflow = {}, context = {}) {
    const timezone = this.getWorkflowTimezone(node, workflow);
    const rawDate = context?.bookingDate || node?.data?.bookingDate || node?.data?.serviceDate || workflow?.settings?.bookingDate || workflow?.config?.bookingDate;
    if (rawDate) {
      const parsed = new Date(rawDate);
      if (!Number.isNaN(parsed.valueOf())) {
        return toDateKey(parsed, timezone);
      }
    }
    return toDateKey(new Date(), timezone);
  }

  getCallerProfile(context = {}) {
    const variables = context.variables || {};
    return {
      customerName: toTrimmedString(
        variables.customerName ||
        variables.callerName ||
        variables.name ||
        variables.clientName ||
        ''
      ),
      customerPhone: toTrimmedString(
        context.callerNumber ||
        variables.callerNumber ||
        variables.customerPhone ||
        variables.phone ||
        ''
      ),
      customerEmail: toTrimmedString(variables.customerEmail || variables.email || ''),
      notes: toTrimmedString(variables.notes || variables.customerNotes || variables.bookingNotes || '')
    };
  }

  buildSlotInventoryPayload(node = {}, workflow = {}, context = {}) {
    const slotDefinitions = this.getSlotDefinitions(node);
    const slotDate = this.getDateKey(node, workflow, context);
    const timezone = this.getWorkflowTimezone(node, workflow);
    return slotDefinitions.map((slot) => ({
      workflowId: workflow?._id,
      nodeId: node?.id,
      slotKey: slot.key,
      slotLabel: slot.label,
      slotStart: slot.startTime,
      slotEnd: slot.endTime,
      slotDate,
      timezone,
      capacity: slot.capacity,
      status: slot.active ? 'available' : 'disabled',
      metadata: {
        ...slot.metadata,
        digit: slot.digit,
        order: slot.order
      }
    }));
  }

  async syncSlotInventory(node = {}, workflow = {}, context = {}) {
    const slots = this.buildSlotInventoryPayload(node, workflow, context);
    if (!workflow?._id || !node?.id || slots.length === 0) return [];

    const synced = [];
    for (const slot of slots) {
      const existingBookingsCount = await AppointmentBooking.countDocuments({
        workflowId: workflow._id,
        nodeId: node.id,
        slotKey: slot.slotKey,
        slotDate: slot.slotDate,
        status: { $in: ['reserved', 'confirmed'] }
      });

      const bookedCount = Number.isFinite(existingBookingsCount) ? existingBookingsCount : 0;
      const nextStatus = !slot.capacity || bookedCount >= slot.capacity ? 'full' : (slot.status || 'available');
      const updated = await BookingSlot.findOneAndUpdate(
        {
          workflowId: workflow._id,
          nodeId: node.id,
          slotKey: slot.slotKey,
          slotDate: slot.slotDate
        },
        {
          $set: {
            slotLabel: slot.slotLabel,
            slotStart: slot.slotStart,
            slotEnd: slot.slotEnd,
            timezone: slot.timezone,
            capacity: slot.capacity,
            status: slot.status === 'disabled' ? 'disabled' : nextStatus,
            metadata: slot.metadata
          },
          $setOnInsert: {
            bookedCount: bookedCount
          }
        },
        {
          new: true,
          upsert: true
        }
      );
      synced.push(updated);
    }
    return synced;
  }

  async getSlotSnapshot(node = {}, workflow = {}, context = {}) {
    const slots = await this.syncSlotInventory(node, workflow, context);
    const orderedSlots = slots
      .map((slot) => {
        const capacity = toPositiveInt(slot.capacity, 1);
        const bookedCount = toDisplayCount(slot.bookedCount);
        const availableSeats = Math.max(0, capacity - bookedCount);
        return {
          ...slot.toObject ? slot.toObject() : slot,
          availableSeats,
          isAvailable: slot.status !== 'disabled' && availableSeats > 0
        };
      })
      .sort((a, b) => {
        const orderA = Number(a?.metadata?.order ?? 0);
        const orderB = Number(b?.metadata?.order ?? 0);
        if (orderA !== orderB) return orderA - orderB;
        return String(a.slotLabel || '').localeCompare(String(b.slotLabel || ''));
      });

    return orderedSlots;
  }

  resolveSlotFromInput(node = {}, workflow = {}, context = {}, userInput = '') {
    const slots = this.getSlotDefinitions(node);
    const normalizedInput = toTrimmedString(userInput).toLowerCase();
    if (!normalizedInput) return null;

    const byDigit = slots.find((slot) => toTrimmedString(slot.digit).toLowerCase() === normalizedInput);
    if (byDigit) return byDigit;

    const byKey = slots.find((slot) => toTrimmedString(slot.key).toLowerCase() === normalizedInput);
    if (byKey) return byKey;

    const byLabel = slots.find((slot) => toTrimmedString(slot.label).toLowerCase() === normalizedInput);
    if (byLabel) return byLabel;

    const byIndex = slots.find((slot, index) => String(index + 1) === normalizedInput);
    return byIndex || null;
  }

  findNextAvailableSlot(slotSnapshot = []) {
    return (slotSnapshot || []).find((slot) => slot?.status !== 'disabled' && Number(slot.availableSeats || 0) > 0) || null;
  }

  buildBookingReference(workflow = {}, node = {}, slot = {}) {
    const prefix = toTrimmedString(node?.data?.bookingReferencePrefix || node?.data?.referencePrefix || 'BK')
      .replace(/[^a-z0-9]+/gi, '')
      .toUpperCase() || 'BK';
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const workflowKey = toTrimmedString(workflow?.promptKey || '').replace(/[^a-z0-9]+/gi, '').toUpperCase().slice(0, 8);
    const slotKey = toTrimmedString(slot?.slotKey || '').replace(/[^a-z0-9]+/gi, '').toUpperCase().slice(0, 6);
    return [prefix, workflowKey, slotKey, suffix].filter(Boolean).join('-');
  }

  buildTokenNumber(node = {}, slot = {}, nextCount = 1) {
    const tokenPrefix = toTrimmedString(node?.data?.tokenPrefix || node?.data?.ticketPrefix || 'T').replace(/[^a-z0-9]+/gi, '').toUpperCase() || 'T';
    return `${tokenPrefix}${String(nextCount).padStart(3, '0')}`;
  }

  buildSelectionPrompt(node = {}, slotSnapshot = [], fallbackText = 'Please choose a slot.') {
    const promptText = toTrimmedString(node?.data?.promptText || node?.data?.messageText || node?.data?.text || fallbackText);
    const availableSlots = (slotSnapshot || [])
      .filter((slot) => slot?.status !== 'disabled')
      .map((slot) => `${slot.metadata?.digit || slot.slotKey}: ${slot.slotLabel}${Number(slot.availableSeats || 0) > 0 ? '' : ' (full)'}`);

    if (availableSlots.length === 0) return promptText;
    return `${promptText} ${availableSlots.join('. ')}.`;
  }

  buildOfferPrompt(node = {}, suggestedSlot = null) {
    const promptText = toTrimmedString(
      node?.data?.offerText ||
      node?.data?.promptText ||
      node?.data?.messageText ||
      'The selected slot is full.'
    );
    if (!suggestedSlot) return promptText;
    const suggestion = toTrimmedString(suggestedSlot.slotLabel || suggestedSlot.label || suggestedSlot.name);
    return `${promptText} The next available slot is ${suggestion}. Would you like to book it?`;
  }

  async reserveBooking({ workflow = {}, node = {}, callSid = '', context = {}, slot = null, preventDuplicates = true } = {}) {
    if (!workflow?._id || !node?.id || !callSid || !slot) {
      return { success: false, error: 'Missing booking context' };
    }

    const slotDate = this.getDateKey(node, workflow, context);
    const slotCapacity = toPositiveInt(slot.capacity, 1);
    const customer = this.getCallerProfile(context);
    if (preventDuplicates) {
      const duplicate = await AppointmentBooking.findOne({
        workflowId: workflow._id,
        callSid
      }).lean();
      if (duplicate) {
        return {
          success: false,
          error: 'A booking already exists for this call',
          booking: duplicate
        };
      }
    }

    const slotDocument = await BookingSlot.findOneAndUpdate(
      {
        workflowId: workflow._id,
        nodeId: node.id,
        slotKey: slot.key,
        slotDate,
        status: { $ne: 'disabled' },
        bookedCount: { $lt: slotCapacity }
      },
      {
        $inc: { bookedCount: 1 },
        $set: {
          slotLabel: slot.label,
          slotStart: slot.startTime || '',
          slotEnd: slot.endTime || '',
          timezone: this.getWorkflowTimezone(node, workflow),
          capacity: slotCapacity,
          status: 'available',
          metadata: {
            ...(slot.metadata || {}),
            digit: slot.digit,
            order: slot.order
          }
        },
        $setOnInsert: {
          workflowId: workflow._id,
          nodeId: node.id,
          slotKey: slot.key,
          slotDate
        }
      },
      {
        new: true,
        upsert: true
      }
    );

    if (!slotDocument) {
      return {
        success: false,
        error: 'Selected slot is full'
      };
    }

    const bookingCount = toDisplayCount(slotDocument.bookedCount);
    const bookingReference = this.buildBookingReference(workflow, node, slot);
    const tokenNumber = this.buildTokenNumber(node, slot, bookingCount);
    const booking = await AppointmentBooking.create({
      workflowId: workflow._id,
      nodeId: node.id,
      callSid,
      slotKey: slot.key,
      slotLabel: slot.label,
      slotStart: slot.startTime || '',
      slotEnd: slot.endTime || '',
      slotDate,
      timezone: this.getWorkflowTimezone(node, workflow),
      tokenNumber,
      bookingReference,
      customerName: customer.customerName,
      customerPhone: customer.customerPhone,
      customerEmail: customer.customerEmail,
      notes: customer.notes,
      status: 'confirmed',
      metadata: {
        slot,
        workflowPromptKey: workflow?.promptKey || null
      }
    });

    return {
      success: true,
      booking,
      slot: slotDocument.toObject ? slotDocument.toObject() : slotDocument
    };
  }

  async sendNotificationLog({
    workflow = {},
    node = {},
    booking = null,
    channel = 'customer',
    recipient = '',
    messageType = 'template',
    templateName = '',
    language = 'en_US',
    payload = {},
    providerMessageId = '',
    status = 'pending',
    errorMessage = ''
  } = {}) {
    if (!workflow?._id || !booking?._id) return null;
    return BookingNotificationLog.create({
      workflowId: workflow._id,
      bookingId: booking._id,
      nodeId: node?.id || '',
      channel,
      recipient,
      messageType,
      templateName,
      language,
      providerMessageId,
      status,
      errorMessage,
      payload
    });
  }

  buildCustomerVariables(booking = {}) {
    // Sequential variable order must match the approved customer WhatsApp template.
    return [
      templateValue(booking.customerName, 'Customer'),
      templateValue(booking.bookingReference),
      templateValue(booking.slotLabel),
      templateValue(booking.slotDate),
      templateValue(booking.tokenNumber)
    ];
  }

  buildAdminVariables(booking = {}) {
    // Sequential variable order must match the approved admin WhatsApp template.
    return [
      templateValue(booking.customerName, 'Customer'),
      templateValue(booking.customerPhone),
      templateValue(booking.slotLabel),
      templateValue(booking.slotDate),
      templateValue(booking.tokenNumber)
    ];
  }

  async notifyBooking({ workflow = {}, node = {}, booking = null, customerRecipient = '', adminRecipient = '' } = {}) {
    if (!workflow?._id || !booking) {
      return { success: false, error: 'Missing booking notification context' };
    }

    const customerTemplateName = toTrimmedString(node?.data?.customerTemplateName || node?.data?.customer_template_name || '');
    const adminTemplateName = toTrimmedString(node?.data?.adminTemplateName || node?.data?.admin_template_name || '');
    const customerText = toTrimmedString(
      node?.data?.customerMessageText ||
      node?.data?.customer_message_text ||
      node?.data?.customerText ||
      `Your booking for ${booking.slotLabel} is confirmed. Reference: ${booking.bookingReference}.`
    );
    const adminText = toTrimmedString(
      node?.data?.adminMessageText ||
      node?.data?.admin_message_text ||
      node?.data?.adminText ||
      `New booking confirmed for ${booking.customerName || booking.customerPhone || 'a customer'} at ${booking.slotLabel}.`
    );
    const customerLanguage = toTrimmedString(
      node?.data?.customerTemplateLanguage ||
      node?.data?.customer_template_language ||
      node?.data?.customer_language ||
      'en_US'
    ) || 'en_US';
    const adminLanguage = toTrimmedString(
      node?.data?.adminTemplateLanguage ||
      node?.data?.admin_template_language ||
      node?.data?.admin_language ||
      'en_US'
    ) || 'en_US';

    const results = [];
    const sendTarget = async (channel, recipient, templateName, language, text, variables) => {
      if (!recipient) return { success: false, error: 'Recipient missing' };
      const normalizedTemplateName = toTrimmedString(templateName);
      const normalizedText = toTrimmedString(text);
      const normalizedVariables = buildSequentialVariables(variables);
      const preferredMessageType = 'template';
      const payload = {
        userId: String(workflow?.createdBy || '').trim(),
        companyId: String(workflow?.companyId || '').trim() || null,
        recipient,
        messageType: preferredMessageType,
        templateName: normalizedTemplateName,
        requestedTemplateName: normalizedTemplateName,
        language,
        variables: normalizedVariables,
        text: normalizedText
      };

      const logEntry = await this.sendNotificationLog({
        workflow,
        node,
        booking,
        channel,
        recipient,
        messageType: preferredMessageType,
        templateName: normalizedTemplateName,
        language,
        payload,
        status: 'pending'
      });

      const updateLogEntry = async (sendResult, extraPayload = {}) => {
        if (!logEntry) return;
        const providerMessageId =
          sendResult?.providerMessageId ||
          sendResult?.data?.messages?.[0]?.id ||
          sendResult?.data?.messageId ||
          '';
        const metaMessage = Array.isArray(sendResult?.data?.messages)
          ? sendResult.data.messages[0] || null
          : null;
        logEntry.status = sendResult.success ? 'sent' : 'failed';
        logEntry.providerMessageId = String(providerMessageId || '').trim();
        logEntry.errorMessage = sendResult.success ? '' : normalizeErrorMessage(sendResult.error);
        logEntry.payload = {
          ...payload,
          providerMessageId: String(providerMessageId || '').trim(),
          providerResponse: sendResult?.data || null,
          metaMessageStatus: metaMessage?.message_status || '',
          ...extraPayload
        };
        await logEntry.save();
      };

      if (!normalizedTemplateName) {
        const result = {
          success: false,
          data: null,
          error: 'Template name not configured',
          channel,
          deliveryMode: 'template',
          fallbackUsed: false
        };
        await updateLogEntry(result, {
          deliveryMode: 'template',
          fallbackUsed: false
        });
        return result;
      }

      const sendResult = await whatsappNotificationBridge.sendNotification(payload);
      await updateLogEntry(sendResult, {
        deliveryMode: 'template',
        fallbackUsed: false,
        normalizedTemplateName,
        normalizedText
      });

      return {
        success: Boolean(sendResult.success),
        data: sendResult.data || null,
        error: sendResult.success ? null : normalizeErrorMessage(sendResult.error, ''),
        channel,
        deliveryMode: 'template',
        fallbackUsed: false,
        providerMessageId:
          sendResult?.providerMessageId ||
          sendResult?.data?.messages?.[0]?.id ||
          sendResult?.data?.messageId ||
          ''
      };
    };

    const sendJobs = [];
    if (customerRecipient) {
      sendJobs.push({
        channel: 'customer',
        promise: sendTarget(
          'customer',
          customerRecipient,
          customerTemplateName,
          customerLanguage,
          customerText,
          this.buildCustomerVariables(booking)
        )
      });
    }

    if (adminRecipient) {
      sendJobs.push({
        channel: 'admin',
        promise: sendTarget(
          'admin',
          adminRecipient,
          adminTemplateName,
          adminLanguage,
          adminText,
          this.buildAdminVariables(booking, workflow)
        )
      });
    }

    if (sendJobs.length > 0) {
      const settledResults = await Promise.allSettled(sendJobs.map((job) => job.promise));
      settledResults.forEach((entry, index) => {
        const channel = sendJobs[index]?.channel || (index === 0 && customerRecipient ? 'customer' : 'admin');
        if (entry.status === 'fulfilled') {
          results.push({
            ...entry.value,
            channel: entry.value?.channel || channel
          });
          return;
        }
        results.push({
          success: false,
          data: null,
          error: normalizeErrorMessage(entry.reason),
          channel,
          deliveryMode: 'template',
          fallbackUsed: false
        });
      });
    }

    if (results.length === 0) {
      return {
        success: false,
        partialFailure: false,
        error: 'No WhatsApp recipients were configured for this booking notification',
        results
      };
    }

    return {
      success: results.length > 0 ? results.some((result) => result.success) : false,
      partialFailure: results.some((result) => !result.success) && results.some((result) => result.success),
      results
    };
  }
}

export default new AppointmentBookingService();
