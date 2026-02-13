import twilio from 'twilio';
import logger from '../utils/logger.js';
import callStateService from '../services/callStateService.js';
import inboundCallService from '../services/inboundCallService.js';
import callbackService from '../services/callbackService.js';
import { emitInboundCallUpdate, emitQueueUpdate } from '../sockets/unifiedSocket.js';

const { twiml: { VoiceResponse } } = twilio;

class InboundWebhooks {
  /**
   * ==========================================
   * Handle Inbound Call Answer Events
   * POST /webhook/call/answered
   * ==========================================
   */
  async handleCallAnswered(req, res) {
    try {
      const { CallSid, From, To, CallDuration } = req.body;

      logger.info(`📞 Inbound call answered: ${CallSid} from ${From}`);

      // Update call state to answered
      await callStateService.updateCallStatus(CallSid, 'in-progress', {
        answerTime: new Date(),
        providerData: {
          twilioStatus: 'in-progress',
          answeredAt: new Date()
        }
      });

      // Emit real-time update
      emitInboundCallUpdate({
        callSid: CallSid,
        from: From,
        to: To,
        status: 'in-progress',
        timestamp: new Date()
      });

      // Return empty TwiML for answered calls
      res.type('text/xml');
      res.send('<Response></Response>');

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Answer webhook error:`, error);
      res.status(500).send('Error processing call answer');
    }
  }

  /**
   * ==========================================
   * Handle Call Completion
   * POST /webhook/call/completed
   * ==========================================
   */
  async handleCallCompleted(req, res) {
    try {
      const { CallSid, CallDuration, From, To } = req.body;

      logger.info(`📞 Inbound call completed: ${CallSid} (${CallDuration}s)`);

      // Update call with completion data
      await callStateService.updateCallStatus(CallSid, 'completed', {
        endTime: new Date(),
        duration: parseInt(CallDuration) || 0,
        providerData: {
          twilioStatus: 'completed',
          twilioDuration: CallDuration
        }
      });

      // End call and cleanup
      await callStateService.endCall(CallSid);

      // Emit real-time update
      emitInboundCallUpdate({
        callSid: CallSid,
        from: From,
        to: To,
        status: 'completed',
        duration: parseInt(CallDuration) || 0,
        timestamp: new Date()
      });

      res.type('text/xml');
      res.send('<Response></Response>');

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Completion webhook error:`, error);
      res.status(500).send('Error processing call completion');
    }
  }

  /**
   * ==========================================
   * Handle Call Failures (Busy, No Answer, etc.)
   * POST /webhook/call/failed
   * ==========================================
   */
  async handleCallFailed(req, res) {
    try {
      const { CallSid, CallStatus, ErrorCode, ErrorMessage, From } = req.body;

      logger.warn(`📞 Inbound call failed: ${CallSid} - ${CallStatus}`);

      // Map Twilio failure statuses
      const statusMap = {
        'busy': 'busy',
        'no-answer': 'no-answer',
        'failed': 'failed',
        'canceled': 'cancelled'
      };

      const mappedStatus = statusMap[CallStatus] || 'failed';

      // Update call with failure information
      await callStateService.updateCallStatus(CallSid, mappedStatus, {
        endTime: new Date(),
        error: {
          code: ErrorCode,
          message: ErrorMessage
        },
        providerData: {
          twilioStatus: CallStatus,
          twilioErrorCode: ErrorCode,
          twilioErrorMessage: ErrorMessage
        }
      });

      // End call and cleanup
      await callStateService.endCall(CallSid);

      // Emit real-time update
      emitInboundCallUpdate({
        callSid: CallSid,
        from: From,
        status: mappedStatus,
        error: { code: ErrorCode, message: ErrorMessage },
        timestamp: new Date()
      });

      res.type('text/xml');
      res.send('<Response></Response>');

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Failure webhook error:`, error);
      res.status(500).send('Error processing call failure');
    }
  }

  /**
   * ==========================================
   * Handle Queue Position Updates
   * POST /webhook/queue/status
   * ==========================================
   */
  async handleQueueStatus(req, res) {
    try {
      const { CallSid, QueueSid, QueuePosition, QueueTime } = req.body;

      logger.info(`📞 Queue status: ${CallSid} position ${QueuePosition}`);

      // Update call state with queue information
      await callStateService.updateCallState(CallSid, {
        queueInfo: {
          queueSid: QueueSid,
          position: parseInt(QueuePosition),
          queueTime: parseInt(QueueTime) || 0
        }
      });

      // Emit queue update
      emitQueueUpdate({
        queueSid: QueueSid,
        callSid: CallSid,
        position: parseInt(QueuePosition),
        timestamp: new Date()
      });

      res.type('text/xml');
      res.send('<Response></Response>');

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Queue status webhook error:`, error);
      res.status(500).send('Error processing queue status');
    }
  }

  /**
   * ==========================================
   * Handle Machine Detection Results
   * POST /webhook/call/machine-detection
   * ==========================================
   */
  async handleMachineDetection(req, res) {
    try {
      const { CallSid, AnsweredBy, From } = req.body;

      logger.info(`🤖 Machine detection: ${CallSid} - ${AnsweredBy}`);

      // Update call with machine detection result
      await callStateService.updateCallState(CallSid, {
        machineDetection: {
          result: AnsweredBy, // 'machine' or 'human'
          detectedAt: new Date()
        }
      });

      // If machine detected, we might want to leave a message or hangup
      if (AnsweredBy === 'machine') {
        logger.info(`[${CallSid}] Answering machine detected, leaving message`);

        const response = new VoiceResponse();
        response.say({
          voice: 'alice',
          language: 'en-US'
        }, 'Hello, this is an automated call. We will call you back later. Thank you.');
        response.hangup();

        res.type('text/xml');
        res.send(response.toString());
      } else {
        // Human detected, continue with normal flow
        res.type('text/xml');
        res.send('<Response></Response>');
      }

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Machine detection webhook error:`, error);
      res.status(500).send('Error processing machine detection');
    }
  }

  /**
   * ==========================================
   * Handle Call Recording Events
   * POST /webhook/call/recording
   * ==========================================
   */
  async handleRecording(req, res) {
    try {
      const { CallSid, RecordingUrl, RecordingDuration, RecordingSid, Digits } = req.body;

      logger.info(`🎙️ Recording available: ${CallSid} - ${RecordingDuration}s`);

      // Update call with recording information
      await callStateService.updateCallState(CallSid, {
        recording: {
          url: RecordingUrl,
          duration: parseInt(RecordingDuration) || 0,
          sid: RecordingSid,
          recordedAt: new Date()
        }
      });

      // If this was a voicemail recording, handle it specially
      if (req.body.voicemail === 'true') {
        await callStateService.updateCallStatus(CallSid, 'completed', {
          voicemail: {
            url: RecordingUrl,
            duration: parseInt(RecordingDuration) || 0,
            receivedAt: new Date()
          },
          endTime: new Date()
        });

        // Thank the caller
        const response = new VoiceResponse();
        response.say({
          voice: 'alice',
          language: 'en-US'
        }, 'Thank you for your message. We will get back to you soon.');
        response.hangup();

        res.type('text/xml');
        res.send(response.toString());
      } else {
        res.type('text/xml');
        res.send('<Response></Response>');
      }

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Recording webhook error:`, error);
      res.status(500).send('Error processing recording');
    }
  }

  /**
   * ==========================================
   * Handle DTMF Input During Calls
   * POST /webhook/call/dtmf
   * ==========================================
   */
  async handleDTMF(req, res) {
    try {
      const { CallSid, Digits, From } = req.body;

      logger.info(`🔢 DTMF input: ${CallSid} - ${Digits}`);

      // Update call state with DTMF input
      await callStateService.updateCallState(CallSid, {
        dtmfInput: {
          digits: Digits,
          receivedAt: new Date()
        }
      });

      // Route DTMF to appropriate handler based on current call state
      const state = callStateService.getCallState(CallSid);
      
      if (state && state.ivrState) {
        // Handle IVR navigation
        const result = await inboundCallService.handleIVRSelection(CallSid, Digits);
        res.type('text/xml');
        res.send(result.twiml);
      } else {
        // Handle general DTMF (could be for opt-out, etc.)
        const response = new VoiceResponse();
        
        if (Digits === '9') {
          // Opt-out handling
          response.say({
            voice: 'alice',
            language: 'en-US'
          }, 'You will no longer receive these calls. Thank you.');
          response.hangup();
        } else {
          // Invalid input
          response.say({
            voice: 'alice',
            language: 'en-US'
          }, 'Invalid selection. Please try again.');
        }

        res.type('text/xml');
        res.send(response.toString());
      }

    } catch (error) {
      logger.error(`[${req.body.CallSid}] DTMF webhook error:`, error);
      res.status(500).send('Error processing DTMF input');
    }
  }

  /**
   * ==========================================
   * Handle Call Transfer Events
   * POST /webhook/call/transfer
   * ==========================================
   */
  async handleTransfer(req, res) {
    try {
      const { CallSid, TransferredSid, TransferTo } = req.body;

      logger.info(`🔄 Call transfer: ${CallSid} -> ${TransferredSid} to ${TransferTo}`);

      // Update call state with transfer information
      await callStateService.updateCallState(CallSid, {
        transfer: {
          transferredTo: TransferTo,
          transferredSid: TransferredSid,
          transferredAt: new Date()
        }
      });

      // Emit transfer update
      emitInboundCallUpdate({
        callSid: CallSid,
        transferredTo: TransferTo,
        status: 'transferred',
        timestamp: new Date()
      });

      res.type('text/xml');
      res.send('<Response></Response>');

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Transfer webhook error:`, error);
      res.status(500).send('Error processing call transfer');
    }
  }

  /**
   * ==========================================
   * Handle Call Park Events
   * POST /webhook/call/park
   * ==========================================
   */
  async handlePark(req, res) {
    try {
      const { CallSid, ParkUrl } = req.body;

      logger.info(`🅿️ Call parked: ${CallSid}`);

      // Update call state with parking information
      await callStateService.updateCallState(CallSid, {
        parked: {
          parkedAt: new Date(),
          parkUrl: ParkUrl
        }
      });

      // Emit park update
      emitInboundCallUpdate({
        callSid: CallSid,
        status: 'parked',
        timestamp: new Date()
      });

      res.type('text/xml');
      res.send('<Response></Response>');

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Park webhook error:`, error);
      res.status(500).send('Error processing call park');
    }
  }

  /**
   * ==========================================
   * Handle Conference Events
   * POST /webhook/conference/events
   * ==========================================
   */
  async handleConferenceEvents(req, res) {
    try {
      const { 
        ConferenceSid, 
        FriendlyName, 
        CallSid, 
        CallStatus, 
        From,
        To 
      } = req.body;

      logger.info(`👥 Conference event: ${ConferenceSid} - ${CallSid} (${CallStatus})`);

      // Update call state with conference information
      await callStateService.updateCallState(CallSid, {
        conference: {
          conferenceSid: ConferenceSid,
          friendlyName: FriendlyName,
          status: CallStatus,
          joinedAt: CallStatus === 'join' ? new Date() : null,
          leftAt: CallStatus === 'leave' ? new Date() : null
        }
      });

      // Emit conference update
      emitInboundCallUpdate({
        callSid: CallSid,
        conferenceSid: ConferenceSid,
        conferenceStatus: CallStatus,
        timestamp: new Date()
      });

      res.type('text/xml');
      res.send('<Response></Response>');

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Conference webhook error:`, error);
      res.status(500).send('Error processing conference event');
    }
  }

  /**
   * ==========================================
   * Handle Callback Status Updates
   * POST /webhook/callback/status/:callbackId
   * ==========================================
   */
  async handleCallbackStatus(req, res) {
    try {
      const { callbackId } = req.params;
      const { CallSid, CallStatus, CallDuration, ErrorCode, ErrorMessage } = req.body;

      logger.info(`📞 Callback status update: ${callbackId} -> ${CallStatus}`);

      // Handle callback status through callback service
      await callbackService.handleCallbackStatus(callbackId, {
        CallSid,
        CallStatus,
        CallDuration,
        ErrorCode,
        ErrorMessage
      });

      res.type('text/xml');
      res.send('<Response></Response>');

    } catch (error) {
      logger.error(`[${req.params.callbackId}] Callback status webhook error:`, error);
      res.status(500).send('Error processing callback status');
    }
  }

  /**
   * ==========================================
   * Handle Payment Collection Events
   * POST /webhook/payment/status
   * ==========================================
   */
  async handlePaymentStatus(req, res) {
    try {
      const { CallSid, PaymentSid, Status, Amount } = req.body;

      logger.info(`💳 Payment status: ${CallSid} - ${Status} (${Amount})`);

      // Update call state with payment information
      await callStateService.updateCallState(CallSid, {
        payment: {
          paymentSid: PaymentSid,
          status: Status,
          amount: parseFloat(Amount) || 0,
          processedAt: new Date()
        }
      });

      // Emit payment update
      emitInboundCallUpdate({
        callSid: CallSid,
        paymentStatus: Status,
        paymentAmount: parseFloat(Amount) || 0,
        timestamp: new Date()
      });

      res.type('text/xml');
      res.send('<Response></Response>');

    } catch (error) {
      logger.error(`[${req.body.CallSid}] Payment webhook error:`, error);
      res.status(500).send('Error processing payment status');
    }
  }
}

export default new InboundWebhooks();
