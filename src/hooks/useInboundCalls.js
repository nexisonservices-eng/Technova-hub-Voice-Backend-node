import { useState, useEffect, useCallback } from 'react';
import apiClient from '../utils/apiClient';
import { API_ENDPOINTS, SOCKET_EVENTS } from '../config/api.config';
import useSocket from './useSocket';

/**
 * Custom hook for inbound call management
 * Handles active calls, queue management, and real-time updates
 */
const useInboundCalls = () => {
  const [activeCalls, setActiveCalls] = useState([]);
  const [callQueue, setCallQueue] = useState([]);
  const [callHistory, setCallHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const { on, off, isConnected } = useSocket();

  /**
   * Fetch active calls
   */
  const fetchActiveCalls = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get(API_ENDPOINTS.INBOUND.ACTIVE_CALLS);
      setActiveCalls(response.data.calls || []);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching active calls:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Fetch call queue
   */
  const fetchCallQueue = useCallback(async () => {
    try {
      const response = await apiClient.get(API_ENDPOINTS.INBOUND.QUEUE);
      setCallQueue(response.data.queue || []);
    } catch (err) {
      console.error('Error fetching call queue:', err);
    }
  }, []);

  /**
   * Transfer call to agent or department
   */
  const transferCall = useCallback(async (callId, destination) => {
    setError(null);

    try {
      const response = await apiClient.post(
        API_ENDPOINTS.INBOUND.TRANSFER(callId),
        { destination }
      );
      return response.data;
    } catch (err) {
      setError(err.message);
      console.error('Error transferring call:', err);
      throw err;
    }
  }, []);

  /**
   * Hangup call
   */
  const hangupCall = useCallback(async (callId) => {
    setError(null);

    try {
      const response = await apiClient.post(API_ENDPOINTS.INBOUND.HANGUP(callId));
      
      // Remove from active calls
      setActiveCalls(prev => prev.filter(call => call._id !== callId));
      
      return response.data;
    } catch (err) {
      setError(err.message);
      console.error('Error hanging up call:', err);
      throw err;
    }
  }, []);

  /**
   * Get call details
   */
  const getCallDetails = useCallback(async (callId) => {
    try {
      const response = await apiClient.get(API_ENDPOINTS.INBOUND.CALL_DETAILS(callId));
      return response.data.call;
    } catch (err) {
      console.error('Error fetching call details:', err);
      return null;
    }
  }, []);

  // Setup Socket.IO listeners for real-time updates
  useEffect(() => {
    if (!isConnected) return;

    // New inbound call received
    const handleInboundCallReceived = (data) => {
      setActiveCalls(prev => {
        const exists = prev.some(call => call._id === data.callId);
        if (!exists) {
          return [...prev, {
            _id: data.callId,
            callSid: data.callSid,
            from: data.from,
            to: data.to,
            status: 'ringing',
            direction: 'inbound',
            receivedAt: new Date(data.timestamp),
            ...data,
          }];
        }
        return prev;
      });
    };

    // Call answered by agent
    const handleInboundCallAnswered = (data) => {
      setActiveCalls(prev =>
        prev.map(call =>
          call._id === data.callId
            ? {
                ...call,
                status: 'in-progress',
                answeredBy: data.agent,
                answeredAt: new Date(data.timestamp),
              }
            : call
        )
      );
    };

    // Call ended
    const handleInboundCallEnded = (data) => {
      setActiveCalls(prev => {
        const endedCall = prev.find(call => call._id === data.callId);
        
        if (endedCall) {
          // Add to history
          setCallHistory(prevHistory => [{
            ...endedCall,
            endedAt: new Date(data.timestamp),
            duration: data.duration,
            disposition: data.disposition,
          }, ...prevHistory].slice(0, 50)); // Keep last 50 calls
        }
        
        return prev.filter(call => call._id !== data.callId);
      });
    };

    // Queue updates
    const handleQueueUpdate = (data) => {
      setCallQueue(data.queue || []);
    };

    const handleQueueCallerAdded = (data) => {
      setCallQueue(prev => {
        const exists = prev.some(caller => caller.callId === data.callId);
        if (!exists) {
          return [...prev, {
            callId: data.callId,
            from: data.from,
            position: data.position,
            waitTime: 0,
            joinedAt: new Date(data.timestamp),
            priority: data.priority || 'normal',
          }];
        }
        return prev;
      });
    };

    const handleQueueCallerRemoved = (data) => {
      setCallQueue(prev => prev.filter(caller => caller.callId !== data.callId));
    };

    const handleQueuePositionUpdate = (data) => {
      setCallQueue(prev =>
        prev.map(caller =>
          caller.callId === data.callId
            ? { ...caller, position: data.position, waitTime: data.waitTime }
            : caller
        )
      );
    };

    // Register listeners
    on(SOCKET_EVENTS.INBOUND_CALL_RECEIVED, handleInboundCallReceived);
    on(SOCKET_EVENTS.INBOUND_CALL_ANSWERED, handleInboundCallAnswered);
    on(SOCKET_EVENTS.INBOUND_CALL_ENDED, handleInboundCallEnded);
    on(SOCKET_EVENTS.QUEUE_UPDATE, handleQueueUpdate);
    on(SOCKET_EVENTS.QUEUE_CALLER_ADDED, handleQueueCallerAdded);
    on(SOCKET_EVENTS.QUEUE_CALLER_REMOVED, handleQueueCallerRemoved);
    on(SOCKET_EVENTS.QUEUE_POSITION_UPDATE, handleQueuePositionUpdate);

    // Cleanup
    return () => {
      off(SOCKET_EVENTS.INBOUND_CALL_RECEIVED);
      off(SOCKET_EVENTS.INBOUND_CALL_ANSWERED);
      off(SOCKET_EVENTS.INBOUND_CALL_ENDED);
      off(SOCKET_EVENTS.QUEUE_UPDATE);
      off(SOCKET_EVENTS.QUEUE_CALLER_ADDED);
      off(SOCKET_EVENTS.QUEUE_CALLER_REMOVED);
      off(SOCKET_EVENTS.QUEUE_POSITION_UPDATE);
    };
  }, [isConnected, on, off]);

  // Fetch initial data on mount
  useEffect(() => {
    fetchActiveCalls();
    fetchCallQueue();
  }, [fetchActiveCalls, fetchCallQueue]);

  // Update queue wait times every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCallQueue(prev =>
        prev.map(caller => ({
          ...caller,
          waitTime: Math.floor((Date.now() - new Date(caller.joinedAt).getTime()) / 1000),
        }))
      );
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  /**
   * Get queue statistics
   */
  const getQueueStats = useCallback(() => {
    const stats = {
      total: callQueue.length,
      avgWaitTime: 0,
      longestWait: 0,
      priorityCalls: 0,
    };

    if (callQueue.length > 0) {
      const totalWaitTime = callQueue.reduce((sum, caller) => sum + (caller.waitTime || 0), 0);
      stats.avgWaitTime = Math.round(totalWaitTime / callQueue.length);
      stats.longestWait = Math.max(...callQueue.map(c => c.waitTime || 0));
      stats.priorityCalls = callQueue.filter(c => c.priority === 'high' || c.priority === 'vip').length;
    }

    return stats;
  }, [callQueue]);

  return {
    activeCalls,
    callQueue,
    callHistory,
    loading,
    error,
    fetchActiveCalls,
    fetchCallQueue,
    transferCall,
    hangupCall,
    getCallDetails,
    getQueueStats,
  };
};

export default useInboundCalls;