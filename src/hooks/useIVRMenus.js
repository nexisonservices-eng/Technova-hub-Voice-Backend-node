import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API_ENDPOINTS } from '../config/api.config';

/**
 * Custom hook for IVR menu management
 * Handles IVR configuration, testing, and real-time updates
 */
const useIVRMenus = () => {
  const [menus, setMenus] = useState([]);
  const [activeMenu, setActiveMenu] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Fetch all IVR menus
   */
  const fetchMenus = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await axios.get(API_ENDPOINTS.IVR.MENUS);
      setMenus(response.data.menus || []);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching IVR menus:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Fetch single IVR menu
   */
  const fetchMenu = useCallback(async (menuId) => {
    setLoading(true);
    setError(null);

    try {
      const response = await axios.get(API_ENDPOINTS.IVR.GET_MENU(menuId));
      setActiveMenu(response.data.menu);
      return response.data.menu;
    } catch (err) {
      setError(err.message);
      console.error('Error fetching IVR menu:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Create new IVR menu
   */
  const createMenu = useCallback(async (menuData) => {
    setLoading(true);
    setError(null);

    console.log('Creating menu with data:', menuData);

    try {
      const response = await axios.post(API_ENDPOINTS.IVR.CREATE_MENU, menuData);
      const newMenu = response.data.menu;
      
      setMenus(prev => [...prev, newMenu]);
      return newMenu;
    } catch (err) {
      console.error('Error creating IVR menu:', err);
      console.error('Error response:', err.response?.data);
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Update IVR menu
   */
  const updateMenu = useCallback(async (menuId, updates) => {
    setLoading(true);
    setError(null);

    try {
      const response = await axios.put(
        API_ENDPOINTS.IVR.UPDATE_MENU(menuId),
        updates
      );
      const updatedMenu = response.data.menu;

      setMenus(prev =>
        prev.map(m => (m._id === menuId ? updatedMenu : m))
      );

      if (activeMenu?._id === menuId) {
        setActiveMenu(updatedMenu);
      }

      return updatedMenu;
    } catch (err) {
      setError(err.message);
      console.error('Error updating IVR menu:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [activeMenu]);

  /**
   * Delete IVR menu
   */
  const deleteMenu = useCallback(async (menuId) => {
    setLoading(true);
    setError(null);

    try {
      await axios.delete(API_ENDPOINTS.IVR.DELETE_MENU(menuId));
      
      setMenus(prev => prev.filter(m => m._id !== menuId));
      
      if (activeMenu?._id === menuId) {
        setActiveMenu(null);
      }
    } catch (err) {
      setError(err.message);
      console.error('Error deleting IVR menu:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [activeMenu]);

  /**
   * Test IVR menu
   */
  const testMenu = useCallback(async (menuId) => {
    setError(null);

    try {
      const response = await axios.post(API_ENDPOINTS.IVR.TEST_MENU(menuId));
      return response.data;
    } catch (err) {
      setError(err.message);
      console.error('Error testing IVR menu:', err);
      throw err;
    }
  }, []);

  // Load menus on mount
  useEffect(() => {
    fetchMenus();
  }, [fetchMenus]);

  return {
    menus,
    activeMenu,
    loading,
    error,
    fetchMenus,
    fetchMenu,
    createMenu,
    updateMenu,
    deleteMenu,
    testMenu,
  };
};

export default useIVRMenus;