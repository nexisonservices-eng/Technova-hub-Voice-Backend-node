import { useState, useEffect, useCallback } from 'react';
import { SOCKET_EVENTS } from '../config/api.config';
import useSocket from './useSocket';

/**
 * Custom hook for tracking individual calls in a campaign
 * Provides real-time call status updates via WebSocket
 */
const useCampaignCalls = (campaignId) => {
  const [calls, setCalls] = useState([]);
  const [activeCalls, setActiveCalls] = useState([]);
  const [callHistory, setCallHistory] = useState([]);
  
  const { on, off, isConnected } = useSocket();

  /**
   * Update call status
   */
  const updateCallStatus = useCallback((callData) => {
    setCalls(prev => {
      const existingIndex = prev.findIndex(c => c.callId === callData.callId);
      
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          ...callData,
          updatedAt: new Date(),
        };
        return updated;
      } else {
        return [...prev, { ...callData, updatedAt: new Date() }];
      }
    });
  }, []);

  /**
   * Mark call as active
   */
  const addActiveCall = useCallback((callData) => {
    setActiveCalls(prev => {
      const exists = prev.some(c => c.callId === callData.callId);
      if (!exists) {
        return [...prev, { ...callData, startedAt: new Date() }];
      }
      return prev;
    });
  }, []);

  /**
   * Remove call from active list
   */
  const removeActiveCall = useCallback((callId) => {
    setActiveCalls(prev => prev.filter(c => c.callId !== callId));
    
    // Move to history
    const completedCall = calls.find(c => c.callId === callId);
    if (completedCall) {
      setCallHistory(prev => [completedCall, ...prev].slice(0, 100)); // Keep last 100
    }
  }, [calls]);

  // Setup Socket.IO listeners for call events
  useEffect(() => {
    if (!isConnected || !campaignId) return;

    // Call initiated
    const handleCallInitiated = (data) => {
      if (data.campaignId === campaignId) {
        updateCallStatus({
          ...data,
          status: 'initiated',
        });
        addActiveCall(data);
      }
    };

    // Call connected (answered)
    const handleCallConnected = (data) => {
      if (data.campaignId === campaignId) {
        updateCallStatus({
          ...data,
          status: 'connected',
          connectedAt: new Date(),
        });
      }
    };

    // Call completed successfully
    const handleCallCompleted = (data) => {
      if (data.campaignId === campaignId) {
        updateCallStatus({
          ...data,
          status: 'completed',
          completedAt: new Date(),
        });
        removeActiveCall(data.callId);
      }
    };

    // Call failed
    const handleCallFailed = (data) => {
      if (data.campaignId === campaignId) {
        updateCallStatus({
          ...data,
          status: 'failed',
          failedAt: new Date(),
        });
        removeActiveCall(data.callId);
      }
    };

    // Generic status update
    const handleStatusUpdate = (data) => {
      if (data.campaignId === campaignId) {
        updateCallStatus(data);
        
        // Update active calls list based on status
        if (['completed', 'failed', 'no-answer', 'busy'].includes(data.status)) {
          removeActiveCall(data.callId);
        }
      }
    };

    // Register listeners
    on(SOCKET_EVENTS.CALL_INITIATED, handleCallInitiated);
    on(SOCKET_EVENTS.CALL_CONNECTED, handleCallConnected);
    on(SOCKET_EVENTS.CALL_COMPLETED, handleCallCompleted);
    on(SOCKET_EVENTS.CALL_FAILED, handleCallFailed);
    on(SOCKET_EVENTS.CALL_STATUS_UPDATE, handleStatusUpdate);

    // Cleanup
    return () => {
      off(SOCKET_EVENTS.CALL_INITIATED);
      off(SOCKET_EVENTS.CALL_CONNECTED);
      off(SOCKET_EVENTS.CALL_COMPLETED);
      off(SOCKET_EVENTS.CALL_FAILED);
      off(SOCKET_EVENTS.CALL_STATUS_UPDATE);
    };
  }, [
    isConnected,
    campaignId,
    on,
    off,
    updateCallStatus,
    addActiveCall,
    removeActiveCall,
  ]);

  /**
   * Get call statistics
   */
  const getCallStats = useCallback(() => {
    const stats = {
      total: calls.length,
      active: activeCalls.length,
      completed: 0,
      failed: 0,
      noAnswer: 0,
      busy: 0,
      voicemail: 0,
      avgDuration: 0,
    };

    let totalDuration = 0;
    let durationCount = 0;

    calls.forEach(call => {
      switch (call.status) {
        case 'completed':
          stats.completed++;
          break;
        case 'failed':
          stats.failed++;
          break;
        case 'no-answer':
          stats.noAnswer++;
          break;
        case 'busy':
          stats.busy++;
          break;
        case 'voicemail':
          stats.voicemail++;
          break;
        default:
          break;
      }

      if (call.duration) {
        totalDuration += call.duration;
        durationCount++;
      }
    });

    if (durationCount > 0) {
      stats.avgDuration = Math.round(totalDuration / durationCount);
    }

    return stats;
  }, [calls, activeCalls]);

  /**
   * Clear call data
   */
  const clearCalls = useCallback(() => {
    setCalls([]);
    setActiveCalls([]);
    setCallHistory([]);
  }, []);

  return {
    calls,
    activeCalls,
    callHistory,
    getCallStats,
    clearCalls,
  };
};

export default useCampaignCalls;