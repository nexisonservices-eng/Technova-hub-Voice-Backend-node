import logger from '../utils/logger.js';
import pythonTTSService from './pythonTTSService.js';

/**
 * Industry-specific node handlers
 * Each handler receives (response, data, callSid, context) and returns TwiML
 */

export const IndustryNodeHandlers = {
  // Hotel Industry Handlers
  async booking_service(response, data, callSid, context) {
    const { service = 'booking', checkIn, checkOut, guests = 1 } = data;
    
    try {
      // Generate dynamic TTS for booking prompt
      const prompt = `Welcome to our hotel booking service. Please provide your check-in date, check-out date, and number of guests. For example, check-in tomorrow, check-out in 3 days, 2 guests.`;
      
      const audioUrl = await pythonTTSService.generateAudio(prompt, 'en-GB');
      if (audioUrl) {
        response.play({}, audioUrl);
      } else {
        response.say({ voice: 'alice' }, prompt);
      }

      // Gather booking information
      response.gather({
        input: 'speech',
        timeout: 10,
        action: `/ivr/hotel/booking`,
        method: 'POST',
        language: 'en-GB'
      });

      return response.toString();
    } catch (error) {
      logger.error('Hotel booking handler error:', error);
      response.say('Our booking service is temporarily unavailable. Please try again later.');
      return response.toString();
    }
  },

  async room_service(response, data, callSid, context) {
    const { roomNumber, serviceType } = data;
    
    response.say({ voice: 'alice' }, `Connecting you to room service for room ${roomNumber || 'your room'}.`);
    response.dial({}, process.env.HOTEL_ROOM_SERVICE_PHONE || '+18005551234');
    
    return response.toString();
  },

  async check_availability(response, data, callSid, context) {
    const { date, roomType } = data;
    
    // In production, integrate with hotel booking system
    response.say({ voice: 'alice' }, `Checking availability for ${roomType || 'rooms'} on ${date || 'today'}. Please hold.`);
    
    // Simulate API call
    setTimeout(() => {
      response.say({ voice: 'alice' }, 'We have rooms available. Would you like to proceed with booking?');
      response.gather({
        numDigits: 1,
        timeout: 5,
        action: '/ivr/hotel/confirm_booking',
        method: 'POST'
      });
    }, 2000);

    return response.toString();
  },

  // Insurance Industry Handlers
  async claims_service(response, data, callSid, context) {
    const { policyNumber, claimType } = data;
    
    try {
      const prompt = policyNumber 
        ? `Please describe your claim for policy ${policyNumber}.`
        : 'Please provide your policy number followed by a description of your claim.';
      
      const audioUrl = await pythonTTSService.generateAudio(prompt, 'en-GB');
      if (audioUrl) {
        response.play({}, audioUrl);
      } else {
        response.say({ voice: 'alice' }, prompt);
      }

      response.gather({
        input: 'speech',
        timeout: 15,
        action: '/ivr/insurance/claims',
        method: 'POST',
        language: 'en-GB'
      });

      return response.toString();
    } catch (error) {
      logger.error('Insurance claims handler error:', error);
      response.say('Our claims service is temporarily unavailable. Please try again later.');
      return response.toString();
    }
  },

  async policy_info(response, data, callSid, context) {
    const { policyNumber } = data;
    
    if (!policyNumber) {
      response.say({ voice: 'alice' }, 'Please provide your policy number.');
      response.gather({
        input: 'speech',
        timeout: 10,
        action: '/ivr/insurance/policy_lookup',
        method: 'POST',
        language: 'en-GB'
      });
    } else {
      // In production, integrate with insurance system
      response.say({ voice: 'alice' }, `Retrieving information for policy ${policyNumber}. Please hold.`);
      response.redirect({ method: 'POST' }, '/ivr/insurance/policy_details');
    }

    return response.toString();
  },

  // Healthcare Industry Handlers
  async appointment_service(response, data, callSid, context) {
    const { department = 'general', preferredDate } = data;
    
    try {
      const prompt = `Welcome to our appointment scheduling service for the ${department} department. Please provide your preferred date and time for the appointment.`;
      
      const audioUrl = await pythonTTSService.generateAudio(prompt, 'en-GB');
      if (audioUrl) {
        response.play({}, audioUrl);
      } else {
        response.say({ voice: 'alice' }, prompt);
      }

      response.gather({
        input: 'speech',
        timeout: 10,
        action: '/ivr/healthcare/appointment',
        method: 'POST',
        language: 'en-GB'
      });

      return response.toString();
    } catch (error) {
      logger.error('Healthcare appointment handler error:', error);
      response.say('Our appointment service is temporarily unavailable. Please try again later.');
      return response.toString();
    }
  },

  async prescription_service(response, data, callSid, context) {
    const { prescriptionNumber } = data;
    
    if (!prescriptionNumber) {
      response.say({ voice: 'alice' }, 'Please provide your prescription number.');
      response.gather({
        input: 'speech',
        timeout: 10,
        action: '/ivr/healthcare/prescription',
        method: 'POST',
        language: 'en-GB'
      });
    } else {
      response.say({ voice: 'alice' }, `Checking prescription ${prescriptionNumber}. Please hold.`);
      response.redirect({ method: 'POST' }, '/ivr/healthcare/prescription_status');
    }

    return response.toString();
  },

  // Retail Industry Handlers
  async product_inquiry(response, data, callSid, context) {
    const { productCode, category } = data;
    
    try {
      const prompt = productCode 
        ? `Checking information for product ${productCode}.`
        : 'Please provide the product code or name you are inquiring about.';
      
      const audioUrl = await pythonTTSService.generateAudio(prompt, 'en-GB');
      if (audioUrl) {
        response.play({}, audioUrl);
      } else {
        response.say({ voice: 'alice' }, prompt);
      }

      if (!productCode) {
        response.gather({
          input: 'speech',
          timeout: 10,
          action: '/ivr/retail/product_lookup',
          method: 'POST',
          language: 'en-GB'
        });
      } else {
        response.redirect({ method: 'POST' }, '/ivr/retail/product_details');
      }

      return response.toString();
    } catch (error) {
      logger.error('Retail product inquiry handler error:', error);
      response.say('Our product information service is temporarily unavailable. Please try again later.');
      return response.toString();
    }
  },

  async order_status(response, data, callSid, context) {
    const { orderNumber } = data;
    
    if (!orderNumber) {
      response.say({ voice: 'alice' }, 'Please provide your order number.');
      response.gather({
        input: 'speech',
        timeout: 10,
        action: '/ivr/retail/order_status',
        method: 'POST',
        language: 'en-GB'
      });
    } else {
      response.say({ voice: 'alice' }, `Checking status for order ${orderNumber}. Please hold.`);
      response.redirect({ method: 'POST' }, '/ivr/retail/order_details');
    }

    return response.toString();
  },

  // Custom/General Purpose Handlers
  async ai_assistant(response, data, callSid, context) {
    const { prompt = 'How can I help you today?' } = data;
    
    try {
      // Use Python AI service for intelligent responses
      const audioUrl = await pythonTTSService.generateAudio(prompt, 'en-GB');
      if (audioUrl) {
        response.play({}, audioUrl);
      } else {
        response.say({ voice: 'alice' }, prompt);
      }

      response.gather({
        input: 'speech',
        timeout: 15,
        action: '/ivr/ai/assistant',
        method: 'POST',
        language: 'en-GB'
      });

      return response.toString();
    } catch (error) {
      logger.error('AI assistant handler error:', error);
      response.say('Our AI assistant is temporarily unavailable. Please try again later.');
      return response.toString();
    }
  },

  async survey(response, data, callSid, context) {
    const { questions = ['How satisfied are you with our service?', 'Would you recommend us to others?'] } = data;
    const currentQuestion = (context.questionIndex || 0);
    
    if (currentQuestion < questions.length) {
      const question = questions[currentQuestion];
      response.say({ voice: 'alice' }, question);
      
      response.gather({
        input: 'speech',
        timeout: 10,
        action: `/ivr/survey/next`,
        method: 'POST',
        language: 'en-GB'
      });
    } else {
      response.say({ voice: 'alice' }, 'Thank you for completing our survey. Your feedback is valuable to us.');
      response.hangup();
    }

    return response.toString();
  },

  async payment(response, data, callSid, context) {
    const { amount, description } = data;
    
    if (!amount) {
      response.say({ voice: 'alice' }, 'Please provide the payment amount.');
      response.gather({
        input: 'speech',
        timeout: 10,
        action: '/ivr/payment/amount',
        method: 'POST',
        language: 'en-GB'
      });
    } else {
      response.say({ voice: 'alice' }, `Processing payment of ${amount} for ${description || 'services'}. Please hold.`);
      
      // In production, integrate with payment gateway
      response.redirect({ method: 'POST' }, '/ivr/payment/process');
    }

    return response.toString();
  }
};

/**
 * Helper function to register new industry handlers
 */
export function registerIndustryHandler(nodeType, handler) {
  IndustryNodeHandlers[nodeType] = handler;
  logger.info(`Registered industry handler for node type: ${nodeType}`);
}

/**
 * Get available industry handlers
 */
export function getIndustryHandlers() {
  return Object.keys(IndustryNodeHandlers);
}
