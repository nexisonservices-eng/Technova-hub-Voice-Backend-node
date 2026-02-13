import { useState, useEffect, useCallback } from 'react';
import apiClient from '../utils/apiClient';
import { API_ENDPOINTS, SOCKET_EVENTS } from '../config/api.config';
import useSocket from './useSocket';

/**
 * Custom hook for callback management
 */
export const useCallbacks = () => {
  const [callbacks, setCallbacks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const { on, off, isConnected } = useSocket();

  /**
   * Fetch all callbacks
   */
  const fetchCallbacks = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get(API_ENDPOINTS.CALLBACKS.LIST);
      setCallbacks(response.data.callbacks || []);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching callbacks:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Create callback
   */
  const createCallback = useCallback(async (callbackData) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.post(API_ENDPOINTS.CALLBACKS.CREATE, callbackData);
      const newCallback = response.data.callback;
      
      setCallbacks(prev => [...prev, newCallback]);
      return newCallback;
    } catch (err) {
      setError(err.message);
      console.error('Error creating callback:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Update callback
   */
  const updateCallback = useCallback(async (callbackId, updates) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.put(
        API_ENDPOINTS.CALLBACKS.UPDATE(callbackId),
        updates
      );
      const updatedCallback = response.data.callback;

      setCallbacks(prev =>
        prev.map(cb => (cb._id === callbackId ? updatedCallback : cb))
      );

      return updatedCallback;
    } catch (err) {
      setError(err.message);
      console.error('Error updating callback:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Complete callback
   */
  const completeCallback = useCallback(async (callbackId) => {
    setLoading(true);
    setError(null);

    try {
      await apiClient.post(API_ENDPOINTS.CALLBACKS.COMPLETE(callbackId));
      setCallbacks(prev => prev.filter(cb => cb._id !== callbackId));
    } catch (err) {
      setError(err.message);
      console.error('Error completing callback:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Delete callback
   */
  const deleteCallback = useCallback(async (callbackId) => {
    setLoading(true);
    setError(null);

    try {
      await apiClient.delete(API_ENDPOINTS.CALLBACKS.DELETE(callbackId));
      setCallbacks(prev => prev.filter(cb => cb._id !== callbackId));
    } catch (err) {
      setError(err.message);
      console.error('Error deleting callback:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Setup Socket.IO listeners
  useEffect(() => {
    if (!isConnected) return;

    const handleCallbackScheduled = (data) => {
      setCallbacks(prev => {
        const exists = prev.some(cb => cb._id === data.callbackId);
        if (!exists) {
          return [...prev, data.callback];
        }
        return prev;
      });
    };

    const handleCallbackDue = (data) => {
      setCallbacks(prev =>
        prev.map(cb =>
          cb._id === data.callbackId
            ? { ...cb, status: 'due', isDue: true }
            : cb
        )
      );
    };

    on(SOCKET_EVENTS.CALLBACK_SCHEDULED, handleCallbackScheduled);
    on(SOCKET_EVENTS.CALLBACK_DUE, handleCallbackDue);

    return () => {
      off(SOCKET_EVENTS.CALLBACK_SCHEDULED);
      off(SOCKET_EVENTS.CALLBACK_DUE);
    };
  }, [isConnected, on, off]);

  // Load callbacks on mount
  useEffect(() => {
    fetchCallbacks();
  }, [fetchCallbacks]);

  return {
    callbacks,
    loading,
    error,
    fetchCallbacks,
    createCallback,
    updateCallback,
    completeCallback,
    deleteCallback,
  };
};

/**
 * Custom hook for voicemail management
 */
export const useVoicemail = () => {
  const [voicemails, setVoicemails] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const { on, off, isConnected } = useSocket();

  /**
   * Fetch all voicemails
   */
  const fetchVoicemails = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get(API_ENDPOINTS.VOICEMAIL.LIST);
      setVoicemails(response.data.voicemails || []);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching voicemails:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Get voicemail details
   */
  const getVoicemail = useCallback(async (voicemailId) => {
    try {
      const response = await apiClient.get(API_ENDPOINTS.VOICEMAIL.GET(voicemailId));
      return response.data.voicemail;
    } catch (err) {
      console.error('Error fetching voicemail:', err);
      return null;
    }
  }, []);

  /**
   * Mark voicemail as read
   */
  const markAsRead = useCallback(async (voicemailId) => {
    setError(null);

    try {
      await apiClient.post(API_ENDPOINTS.VOICEMAIL.MARK_READ(voicemailId));
      
      setVoicemails(prev =>
        prev.map(vm =>
          vm._id === voicemailId ? { ...vm, isRead: true } : vm
        )
      );
    } catch (err) {
      setError(err.message);
      console.error('Error marking voicemail as read:', err);
      throw err;
    }
  }, []);

  /**
   * Delete voicemail
   */
  const deleteVoicemail = useCallback(async (voicemailId) => {
    setLoading(true);
    setError(null);

    try {
      await apiClient.delete(API_ENDPOINTS.VOICEMAIL.DELETE(voicemailId));
      setVoicemails(prev => prev.filter(vm => vm._id !== voicemailId));
    } catch (err) {
      setError(err.message);
      console.error('Error deleting voicemail:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Get transcription
   */
  const getTranscription = useCallback(async (voicemailId) => {
    try {
      const response = await apiClient.get(API_ENDPOINTS.VOICEMAIL.TRANSCRIPTION(voicemailId));
      return response.data.transcription;
    } catch (err) {
      console.error('Error fetching transcription:', err);
      return null;
    }
  }, []);

  // Setup Socket.IO listeners
  useEffect(() => {
    if (!isConnected) return;

    const handleVoicemailReceived = (data) => {
      setVoicemails(prev => [data.voicemail, ...prev]);
    };

    const handleVoicemailTranscribed = (data) => {
      setVoicemails(prev =>
        prev.map(vm =>
          vm._id === data.voicemailId
            ? { ...vm, transcription: data.transcription, transcriptionStatus: 'completed' }
            : vm
        )
      );
    };

    on(SOCKET_EVENTS.VOICEMAIL_RECEIVED, handleVoicemailReceived);
    on(SOCKET_EVENTS.VOICEMAIL_TRANSCRIBED, handleVoicemailTranscribed);

    return () => {
      off(SOCKET_EVENTS.VOICEMAIL_RECEIVED);
      off(SOCKET_EVENTS.VOICEMAIL_TRANSCRIBED);
    };
  }, [isConnected, on, off]);

  // Load voicemails on mount
  useEffect(() => {
    fetchVoicemails();
  }, [fetchVoicemails]);

  return {
    voicemails,
    loading,
    error,
    fetchVoicemails,
    getVoicemail,
    markAsRead,
    deleteVoicemail,
    getTranscription,
  };
};