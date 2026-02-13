import { useState, useEffect, useCallback } from 'react';
import apiClient from '../utils/apiClient';
import { API_ENDPOINTS } from '../config/api.config';

/**
 * Custom hook for routing rules management
 * Handles VIP, department, time-based, and skill-based routing
 */
const useRoutingRules = () => {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Fetch all routing rules
   */
  const fetchRules = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get(API_ENDPOINTS.ROUTING.RULES);
      setRules(response.data.rules || []);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching routing rules:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Create new routing rule
   */
  const createRule = useCallback(async (ruleData) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.post(API_ENDPOINTS.ROUTING.CREATE_RULE, ruleData);
      const newRule = response.data.rule;
      
      setRules(prev => [...prev, newRule]);
      return newRule;
    } catch (err) {
      setError(err.message);
      console.error('Error creating routing rule:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Update routing rule
   */
  const updateRule = useCallback(async (ruleId, updates) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.put(
        API_ENDPOINTS.ROUTING.UPDATE_RULE(ruleId),
        updates
      );
      const updatedRule = response.data.rule;

      setRules(prev =>
        prev.map(r => (r._id === ruleId ? updatedRule : r))
      );

      return updatedRule;
    } catch (err) {
      setError(err.message);
      console.error('Error updating routing rule:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Delete routing rule
   */
  const deleteRule = useCallback(async (ruleId) => {
    setLoading(true);
    setError(null);

    try {
      await apiClient.delete(API_ENDPOINTS.ROUTING.DELETE_RULE(ruleId));
      setRules(prev => prev.filter(r => r._id !== ruleId));
    } catch (err) {
      setError(err.message);
      console.error('Error deleting routing rule:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Reorder routing rules (priority-based)
   */
  const reorderRules = useCallback(async (ruleIds) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.post(API_ENDPOINTS.ROUTING.REORDER, {
        ruleIds,
      });

      setRules(response.data.rules || []);
    } catch (err) {
      setError(err.message);
      console.error('Error reordering routing rules:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Load rules on mount
  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  return {
    rules,
    loading,
    error,
    fetchRules,
    createRule,
    updateRule,
    deleteRule,
    reorderRules,
  };
};

export default useRoutingRules;