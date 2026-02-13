import twilio from 'twilio';

const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Centralized TwiML generation utility
 * Reduces duplicate TwiML creation code
 */
export class TwiMLHelper {
  /**
   * Create basic response with text-to-speech
   */
  static createSayResponse(text, options = {}) {
    const response = new VoiceResponse();
    response.say({
      voice: 'alice',
      language: 'en-US',
      ...options
    }, text);
    
    return response.toString();
  }

  /**
   * Create response with gather
   */
  static createGatherResponse(text, actionUrl, options = {}) {
    const response = new VoiceResponse();
    
    const gather = response.gather({
      action: actionUrl,
      method: 'POST',
      timeout: 10,
      ...options.gather
    });
    
    gather.say({
      voice: 'alice',
      language: 'en-US',
      ...options.say
    }, text);
    
    return response.toString();
  }

  /**
   * Create play response
   */
  static createPlayResponse(audioUrl, options = {}) {
    const response = new VoiceResponse();
    response.play({
      loop: options.loop || 1,
      ...options
    }, audioUrl);
    
    return response.toString();
  }

  /**
   * Create dial response
   */
  static createDialResponse(phoneNumber, options = {}) {
    const response = new VoiceResponse();
    
    const dial = response.dial({
      callerId: options.callerId,
      timeout: options.timeout || 30,
      ...options
    });
    
    dial.number(phoneNumber);
    
    return response.toString();
  }

  /**
   * Create hangup response
   */
  static createHangupResponse() {
    const response = new VoiceResponse();
    response.hangup();
    return response.toString();
  }

  /**
   * Create error response with fallback
   */
  static createErrorResponse(message = 'We are experiencing technical difficulties. Please try again later.') {
    const response = new VoiceResponse();
    
    response.say({
      voice: 'alice',
      language: 'en-US',
      rate: 'slow'
    }, message);
    
    // Add retry option
    const gather = response.gather({
      numDigits: 1,
      timeout: 5,
      action: '/ivr/welcome',
      method: 'POST'
    });
    
    gather.say({
      voice: 'alice',
      language: 'en-US',
      rate: 'slow'
    }, 'Press 1 to try again, or hang up to disconnect.');
    
    response.hangup();
    
    return response.toString();
  }

  /**
   * Create welcome menu with language selection
   */
  static createWelcomeMenu(welcomeText, languageSelectionText, actionUrl) {
    const response = new VoiceResponse();
    
    // Play welcome message
    response.say({
      voice: 'alice',
      language: 'en-US'
    }, welcomeText);
    
    // Language selection
    const gather = response.gather({
      numDigits: 1,
      timeout: 10,
      action: actionUrl,
      method: 'POST'
    });
    
    gather.say({
      voice: 'alice',
      language: 'en-US'
    }, languageSelectionText);
    
    return response.toString();
  }

  /**
   * Create main menu
   */
  static createMainMenu(menuText, actionUrl) {
    const response = new VoiceResponse();
    
    const gather = response.gather({
      numDigits: 1,
      timeout: 10,
      action: actionUrl,
      method: 'POST'
    });
    
    gather.say({
      voice: 'alice',
      language: 'en-US'
    }, menuText);
    
    return response.toString();
  }

  /**
   * Create transfer to operator response
   */
  static createOperatorTransfer(transferMessage, operatorNumber) {
    const response = new VoiceResponse();
    
    response.say({
      voice: 'alice',
      language: 'en-US'
    }, transferMessage);
    
    response.dial(operatorNumber);
    
    return response.toString();
  }

  /**
   * Create voicemail response
   */
  static createVoicemailResponse(voicemailMessage, recordingUrl = null) {
    const response = new VoiceResponse();
    
    if (recordingUrl) {
      response.play(recordingUrl);
    } else {
      response.say({
        voice: 'alice',
        language: 'en-US'
      }, voicemailMessage);
    }
    
    response.say({
      voice: 'alice',
      language: 'en-US'
    }, 'Thank you for your message. We will get back to you soon.');
    
    return response.toString();
  }

  /**
   * Create callback response
   */
  static createCallbackResponse(callbackMessage, actionUrl) {
    const response = new VoiceResponse();
    
    response.say({
      voice: 'alice',
      language: 'en-US'
    }, callbackMessage);
    
    const gather = response.gather({
      numDigits: 15,
      timeout: 10,
      finishOnKey: '#',
      action: actionUrl,
      method: 'POST'
    });
    
    gather.say({
      voice: 'alice',
      language: 'en-US'
    }, 'Please enter your phone number, followed by the pound key.');
    
    return response.toString();
  }
}

export default TwiMLHelper;
