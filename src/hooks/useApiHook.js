import { useState, useCallback, useEffect } from 'react';
import useSocket from './useSocket';

/**
 * Base hook factory for API operations with consistent patterns
 * Reduces duplication across all API hooks
 */
export const createApiHook = (config) => {
  const {
    apiEndpoints,
    socketEvents = {},
    initialData = [],
    dataKey = 'data',
    autoFetch = true
  } = config;

  return (id = null) => {
    const [data, setData] = useState(initialData);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [activeItem, setActiveItem] = useState(null);

    const { on, off, isConnected } = useSocket();

    // Generic fetch function
    const fetchData = useCallback(async (endpoint, updateState = true) => {
      setLoading(true);
      setError(null);

      try {
        const response = await endpoint();
        const result = response.data[dataKey] || response.data;
        
        if (updateState) {
          if (id && !Array.isArray(result)) {
            setActiveItem(result);
          } else {
            setData(Array.isArray(result) ? result : [result]);
          }
        }
        
        return result;
      } catch (err) {
        setError(err.message);
        console.error(`Error fetching ${dataKey}:`, err);
        throw err;
      } finally {
        setLoading(false);
      }
    }, [id, dataKey]);

    // Generic create function
    const createItem = useCallback(async (endpoint, itemData) => {
      setLoading(true);
      setError(null);

      try {
        const response = await endpoint(itemData);
        const newItem = response.data[dataKey] || response.data;
        
        setData(prev => Array.isArray(prev) ? [...prev, newItem] : [newItem]);
        return newItem;
      } catch (err) {
        setError(err.message);
        console.error(`Error creating ${dataKey}:`, err);
        throw err;
      } finally {
        setLoading(false);
      }
    }, [dataKey]);

    // Generic update function
    const updateItem = useCallback(async (endpoint, itemId, updates) => {
      setLoading(true);
      setError(null);

      try {
        const response = await endpoint(itemId, updates);
        const updatedItem = response.data[dataKey] || response.data;

        setData(prev =>
          Array.isArray(prev)
            ? prev.map(item => (item._id === itemId ? updatedItem : item))
            : updatedItem
        );

        if (activeItem?._id === itemId) {
          setActiveItem(updatedItem);
        }

        return updatedItem;
      } catch (err) {
        setError(err.message);
        console.error(`Error updating ${dataKey}:`, err);
        throw err;
      } finally {
        setLoading(false);
      }
    }, [dataKey, activeItem]);

    // Generic delete function
    const deleteItem = useCallback(async (endpoint, itemId) => {
      setLoading(true);
      setError(null);

      try {
        await endpoint(itemId);
        
        setData(prev =>
          Array.isArray(prev) ? prev.filter(item => item._id !== itemId) : []
        );

        if (activeItem?._id === itemId) {
          setActiveItem(null);
        }
      } catch (err) {
        setError(err.message);
        console.error(`Error deleting ${dataKey}:`, err);
        throw err;
      } finally {
        setLoading(false);
      }
    }, [dataKey, activeItem]);

    // Setup socket listeners
    useEffect(() => {
      if (!isConnected || Object.keys(socketEvents).length === 0) return;

      const handlers = {};

      Object.entries(socketEvents).forEach(([event, handler]) => {
        handlers[event] = (data) => {
          handler(data, { setData, setActiveItem, data });
        };
        on(event, handlers[event]);
      });

      return () => {
        Object.keys(handlers).forEach(event => {
          off(event, handlers[event]);
        });
      };
    }, [isConnected, on, off, socketEvents]);

    // Auto-fetch on mount
    useEffect(() => {
      if (autoFetch && apiEndpoints.list) {
        fetchData(apiEndpoints.list);
      }
    }, [autoFetch, apiEndpoints.list, fetchData]);

    return {
      data,
      activeItem,
      loading,
      error,
      fetchData,
      createItem,
      updateItem,
      deleteItem,
      setActiveItem,
      setData
    };
  };
};

export default createApiHook;
