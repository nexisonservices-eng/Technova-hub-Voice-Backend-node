import { useEffect, useRef, useCallback, useState } from 'react';
import io from 'socket.io-client';
import { WS_CONFIG, SOCKET_EVENTS } from '../config/api.config';

/**
 * Custom hook for Socket.IO connection management
 * Handles connection, disconnection, and event listeners with proper cleanup
 */
const useSocket = () => {
  const socketRef = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const listenersRef = useRef(new Map());

  // Initialize socket connection
  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    
    if (!token) {
      setError('Authentication token not found');
      return;
    }

    const socket = io(WS_CONFIG.url, {
      ...WS_CONFIG.options,
      auth: {
        token,
      },
    });

    socketRef.current = socket;

    // Connection event handlers
    socket.on(SOCKET_EVENTS.CONNECT, () => {
      console.log('Socket.IO connected:', socket.id);
      setIsConnected(true);
      setError(null);
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, (reason) => {
      console.log('Socket.IO disconnected:', reason);
      setIsConnected(false);
    });

    socket.on(SOCKET_EVENTS.ERROR, (err) => {
      console.error('Socket.IO error:', err);
      setError(err.message || 'Socket connection error');
    });

    // Connect socket
    socket.connect();

    // Cleanup on unmount
    return () => {
      if (socket) {
        // Remove all listeners
        listenersRef.current.forEach((_, event) => {
          socket.off(event);
        });
        listenersRef.current.clear();
        
        socket.disconnect();
        socketRef.current = null;
      }
    };
  }, []);

  /**
   * Subscribe to a socket event
   * @param {string} event - Event name
   * @param {function} callback - Event handler
   */
  const on = useCallback((event, callback) => {
    if (!socketRef.current) {
      console.warn('Socket not initialized');
      return;
    }

    // Remove existing listener if any
    if (listenersRef.current.has(event)) {
      socketRef.current.off(event, listenersRef.current.get(event));
    }

    // Add new listener
    socketRef.current.on(event, callback);
    listenersRef.current.set(event, callback);
  }, []);

  /**
   * Unsubscribe from a socket event
   * @param {string} event - Event name
   */
  const off = useCallback((event) => {
    if (!socketRef.current) return;

    const callback = listenersRef.current.get(event);
    if (callback) {
      socketRef.current.off(event, callback);
      listenersRef.current.delete(event);
    }
  }, []);

  /**
   * Emit a socket event
   * @param {string} event - Event name
   * @param {any} data - Data to send
   */
  const emit = useCallback((event, data) => {
    if (!socketRef.current || !isConnected) {
      console.warn('Socket not connected');
      return;
    }

    socketRef.current.emit(event, data);
  }, [isConnected]);

  /**
   * Emit event and wait for acknowledgment
   * @param {string} event - Event name
   * @param {any} data - Data to send
   * @returns {Promise} Promise that resolves with acknowledgment data
   */
  const emitWithAck = useCallback((event, data) => {
    return new Promise((resolve, reject) => {
      if (!socketRef.current || !isConnected) {
        reject(new Error('Socket not connected'));
        return;
      }

      socketRef.current.emit(event, data, (response) => {
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }, [isConnected]);

  return {
    socket: socketRef.current,
    isConnected,
    error,
    on,
    off,
    emit,
    emitWithAck,
  };
};

export default useSocket;