import WebSocket from 'ws';
import EventEmitter from 'events';
import axios from 'axios';
import logger from '../utils/logger.js';

class AIBridgeService extends EventEmitter {
  constructor(callId) {
    super();
    this.callId = callId;
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.messageQueue = [];
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
  }

  /* ======================
     Connect to AI Service
  ======================= */
  async connect() {
    return new Promise((resolve, reject) => {
      logger.info(`[${this.callId}] Connecting → ${process.env.AI_SERVICE_URL || 'ws://localhost:4000'}`);

      this.ws = new WebSocket(`${process.env.AI_SERVICE_URL || 'ws://localhost:4000'}/ws/${this.callId}`);

      this.ws.on('open', () => {
        logger.info(`[${this.callId}] ✓ Connected to AI service`);
        this.connected = true;
        this.reconnectAttempts = 0;
        this.processQueue();
        this.startHeartbeat();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleAIMessage(msg);
        } catch (err) {
          logger.error(`[${this.callId}] Parse error`, err);
        }
      });

      this.ws.on('error', (err) => {
        logger.error(`[${this.callId}] WebSocket error`, err);
        this.emit('error', err);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        logger.warn(`[${this.callId}] Disconnected from AI service (code: ${code}, reason: ${reason || 'unknown'})`);
        this.connected = false;
        this.stopHeartbeat();
        this.emit('disconnected');

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnect();
        } else {
          logger.error(`[${this.callId}] Max reconnection attempts reached`);
          this.emit('error', new Error('Max reconnection attempts reached'));
        }
      });

      setTimeout(() => {
        if (!this.connected) reject(new Error('AI service connection timeout'));
      }, 10_000);
    });
  }

  /* ======================
     Handle Incoming Messages
  ======================= */
  handleAIMessage(msg) {
    const { type, text, audio, format, error } = msg;
    logger.debug(`[${this.callId}] AI → ${type}`);

    switch (type) {
      case 'transcription':
        this.emit('transcription', { text });
        break;
      case 'ai_response':
        this.emit('ai_response', { text });
        break;
      case 'audio_response':
        this.emit('audio_response', {
          audio: Buffer.from(audio, 'hex'),
          format
        });
        break;
      case 'error':
        this.emit('ai_error', { error });
        break;
      case 'heartbeat':
        break;
      default:
        logger.warn(`[${this.callId}] Unknown message type: ${type}`);
    }
  }

  /* ======================
     Send Audio/Text to AI
  ======================= */
  sendAudio(audioBuffer) {
    this.sendMessage({
      type: 'audio_chunk',
      audio: audioBuffer.toString('hex'),
      call_id: this.callId
    });
  }

  sendText(text) {
    this.sendMessage({
      type: 'text_message',
      text,
      call_id: this.callId
    });
  }

  /* ======================
     Generic Send Message
  ======================= */
  sendMessage(message) {
    if (!this.connected) {
      logger.warn(`[${this.callId}] Not connected – queued`);
      this.messageQueue.push(message);
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      logger.error(`[${this.callId}] Send failed`, err);
      this.messageQueue.push(message);
    }
  }

  processQueue() {
    while (this.messageQueue.length && this.connected) {
      const msg = this.messageQueue.shift();
      this.ws.send(JSON.stringify(msg));
    }
  }

  /* ======================
     Conversation Control
  ======================= */
  resetConversation() {
    this.sendMessage({ type: 'reset', call_id: this.callId });
  }

  endCall() {
    if (!this.connected) return;
    this.sendMessage({ type: 'end_call', call_id: this.callId });
    setTimeout(() => this.disconnect(), 1_000);
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.connected = false;
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.connected && this.ws) {
        this.sendMessage({ type: 'heartbeat', call_id: this.callId });
      }
    }, 30000); // 30 seconds
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  reconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    
    this.reconnectAttempts++;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 10_000);
    logger.info(
      `[${this.callId}] Reconnecting in ${delay} ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch((err) => {
        logger.error(`[${this.callId}] Reconnection failed`, err);
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnect();
        }
      });
    }, delay);
  }

  /* ======================
     Health & Test (HTTP)
  ======================= */
    static async checkHealth() {
    try {
      const res = await axios.get(`${process.env.AI_SERVICE_HTTP || 'http://localhost:4000'}/health`, { timeout: 3000 });
      return { status: 'ok', data: res.data };
    } catch (err) {
      return { status: 'unhealthy', error: err.message };
    }
  }

  static async testAI(text) {
    try {
      const res = await axios.post(
        `${process.env.AI_SERVICE_HTTP || 'http://localhost:4000'}/test-ai`,
        { message: text },
        { timeout: 10_000 }
      );
      return res.data;
    } catch (err) {
      logger.error('AI test failed', err.message);
      throw err;
    }
  }
}

export default AIBridgeService;
