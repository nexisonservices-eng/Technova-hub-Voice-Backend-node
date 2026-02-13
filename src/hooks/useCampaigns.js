import { useState, useEffect, useCallback } from 'react';
import apiClient from '../utils/apiClient';
import { API_ENDPOINTS, SOCKET_EVENTS } from '../config/api.config';
import useSocket from './useSocket';

/**
 * Custom hook for outbound campaign management
 * Handles campaign CRUD, real-time updates, and statistics
 */
const useCampaigns = () => {
  const [campaigns, setCampaigns] = useState([]);
  const [activeCampaign, setActiveCampaign] = useState(null);
  const [campaignStats, setCampaignStats] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  const { on, off, isConnected } = useSocket();

  /**
   * Fetch all campaigns
   */
  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get(API_ENDPOINTS.CAMPAIGNS.LIST);
      setCampaigns(response.data.campaigns || []);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching campaigns:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Fetch single campaign details
   */
  const fetchCampaign = useCallback(async (campaignId) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get(API_ENDPOINTS.CAMPAIGNS.GET(campaignId));
      setActiveCampaign(response.data.campaign);
      return response.data.campaign;
    } catch (err) {
      setError(err.message);
      console.error('Error fetching campaign:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Create new campaign
   */
  const createCampaign = useCallback(async (campaignData) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.post(API_ENDPOINTS.CAMPAIGNS.CREATE, campaignData);
      const newCampaign = response.data.campaign;
      
      setCampaigns(prev => [...prev, newCampaign]);
      return newCampaign;
    } catch (err) {
      setError(err.message);
      console.error('Error creating campaign:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Update campaign
   */
  const updateCampaign = useCallback(async (campaignId, updates) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.put(
        API_ENDPOINTS.CAMPAIGNS.UPDATE(campaignId),
        updates
      );
      const updatedCampaign = response.data.campaign;

      setCampaigns(prev =>
        prev.map(c => (c._id === campaignId ? updatedCampaign : c))
      );

      if (activeCampaign?._id === campaignId) {
        setActiveCampaign(updatedCampaign);
      }

      return updatedCampaign;
    } catch (err) {
      setError(err.message);
      console.error('Error updating campaign:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [activeCampaign]);

  /**
   * Delete campaign
   */
  const deleteCampaign = useCallback(async (campaignId) => {
    setLoading(true);
    setError(null);

    try {
      await apiClient.delete(API_ENDPOINTS.CAMPAIGNS.DELETE(campaignId));
      
      setCampaigns(prev => prev.filter(c => c._id !== campaignId));
      
      if (activeCampaign?._id === campaignId) {
        setActiveCampaign(null);
      }
    } catch (err) {
      setError(err.message);
      console.error('Error deleting campaign:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [activeCampaign]);

  /**
   * Upload and validate contacts CSV
   */
  const uploadContacts = useCallback(async (campaignId, file, Papa) => {
    setLoading(true);
    setError(null);

    try {
      // Parse CSV using Papa Parse
      const parseResult = await new Promise((resolve, reject) => {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: resolve,
          error: reject,
        });
      });

      const contacts = parseResult.data;

      // Validate required fields
      const requiredFields = ['phone', 'name'];
      const hasRequiredFields = requiredFields.every(field =>
        contacts.length > 0 && field in contacts[0]
      );

      if (!hasRequiredFields) {
        throw new Error(`CSV must contain columns: ${requiredFields.join(', ')}`);
      }

      // Validate phone numbers
      const validContacts = contacts.filter(contact => {
        const phone = contact.phone?.toString().trim();
        return phone && /^\+?[1-9]\d{1,14}$/.test(phone);
      });

      if (validContacts.length === 0) {
        throw new Error('No valid phone numbers found in CSV');
      }

      // Upload to backend
      const response = await apiClient.post(
        API_ENDPOINTS.CAMPAIGNS.UPLOAD_CONTACTS(campaignId),
        { contacts: validContacts }
      );

      return {
        total: contacts.length,
        valid: validContacts.length,
        invalid: contacts.length - validContacts.length,
        uploaded: response.data.uploaded || validContacts.length,
      };
    } catch (err) {
      setError(err.message);
      console.error('Error uploading contacts:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Start campaign
   */
  const startCampaign = useCallback(async (campaignId) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.post(API_ENDPOINTS.CAMPAIGNS.START(campaignId));
      const updatedCampaign = response.data.campaign;

      setCampaigns(prev =>
        prev.map(c => (c._id === campaignId ? updatedCampaign : c))
      );

      return updatedCampaign;
    } catch (err) {
      setError(err.message);
      console.error('Error starting campaign:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Pause campaign
   */
  const pauseCampaign = useCallback(async (campaignId) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.post(API_ENDPOINTS.CAMPAIGNS.PAUSE(campaignId));
      const updatedCampaign = response.data.campaign;

      setCampaigns(prev =>
        prev.map(c => (c._id === campaignId ? updatedCampaign : c))
      );

      return updatedCampaign;
    } catch (err) {
      setError(err.message);
      console.error('Error pausing campaign:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Resume campaign
   */
  const resumeCampaign = useCallback(async (campaignId) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.post(API_ENDPOINTS.CAMPAIGNS.RESUME(campaignId));
      const updatedCampaign = response.data.campaign;

      setCampaigns(prev =>
        prev.map(c => (c._id === campaignId ? updatedCampaign : c))
      );

      return updatedCampaign;
    } catch (err) {
      setError(err.message);
      console.error('Error resuming campaign:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Stop campaign
   */
  const stopCampaign = useCallback(async (campaignId) => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.post(API_ENDPOINTS.CAMPAIGNS.STOP(campaignId));
      const updatedCampaign = response.data.campaign;

      setCampaigns(prev =>
        prev.map(c => (c._id === campaignId ? updatedCampaign : c))
      );

      return updatedCampaign;
    } catch (err) {
      setError(err.message);
      console.error('Error stopping campaign:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Fetch campaign statistics
   */
  const fetchCampaignStats = useCallback(async (campaignId) => {
    try {
      const response = await apiClient.get(API_ENDPOINTS.CAMPAIGNS.STATISTICS(campaignId));
      const stats = response.data.statistics;

      setCampaignStats(prev => ({
        ...prev,
        [campaignId]: stats,
      }));

      return stats;
    } catch (err) {
      console.error('Error fetching campaign stats:', err);
      return null;
    }
  }, []);

  // Setup Socket.IO listeners for real-time updates
  useEffect(() => {
    if (!isConnected) return;

    // Campaign status updates
    const handleCampaignStarted = (data) => {
      setCampaigns(prev =>
        prev.map(c => (c._id === data.campaignId ? { ...c, status: 'running' } : c))
      );
    };

    const handleCampaignPaused = (data) => {
      setCampaigns(prev =>
        prev.map(c => (c._id === data.campaignId ? { ...c, status: 'paused' } : c))
      );
    };

    const handleCampaignResumed = (data) => {
      setCampaigns(prev =>
        prev.map(c => (c._id === data.campaignId ? { ...c, status: 'running' } : c))
      );
    };

    const handleCampaignStopped = (data) => {
      setCampaigns(prev =>
        prev.map(c => (c._id === data.campaignId ? { ...c, status: 'stopped' } : c))
      );
    };

    const handleCampaignCompleted = (data) => {
      setCampaigns(prev =>
        prev.map(c => (c._id === data.campaignId ? { ...c, status: 'completed' } : c))
      );
    };

    // Real-time statistics updates
    const handleStatsUpdate = (data) => {
      setCampaignStats(prev => ({
        ...prev,
        [data.campaignId]: {
          ...prev[data.campaignId],
          ...data.statistics,
        },
      }));
    };

    // Register listeners
    on(SOCKET_EVENTS.CAMPAIGN_STARTED, handleCampaignStarted);
    on(SOCKET_EVENTS.CAMPAIGN_PAUSED, handleCampaignPaused);
    on(SOCKET_EVENTS.CAMPAIGN_RESUMED, handleCampaignResumed);
    on(SOCKET_EVENTS.CAMPAIGN_STOPPED, handleCampaignStopped);
    on(SOCKET_EVENTS.CAMPAIGN_COMPLETED, handleCampaignCompleted);
    on(SOCKET_EVENTS.CAMPAIGN_STATS_UPDATE, handleStatsUpdate);

    // Cleanup
    return () => {
      off(SOCKET_EVENTS.CAMPAIGN_STARTED);
      off(SOCKET_EVENTS.CAMPAIGN_PAUSED);
      off(SOCKET_EVENTS.CAMPAIGN_RESUMED);
      off(SOCKET_EVENTS.CAMPAIGN_STOPPED);
      off(SOCKET_EVENTS.CAMPAIGN_COMPLETED);
      off(SOCKET_EVENTS.CAMPAIGN_STATS_UPDATE);
    };
  }, [isConnected, on, off]);

  // Load campaigns on mount
  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  return {
    campaigns,
    activeCampaign,
    campaignStats,
    loading,
    error,
    fetchCampaigns,
    fetchCampaign,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    uploadContacts,
    startCampaign,
    pauseCampaign,
    resumeCampaign,
    stopCampaign,
    fetchCampaignStats,
  };
};

export default useCampaigns;