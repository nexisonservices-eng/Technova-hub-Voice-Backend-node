import express from 'express';
import analyticsController from '../controllers/analyticsController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * @route   GET /api/analytics/inbound
 * @desc    Get comprehensive inbound call analytics
 * @access  Private
 */
router.get('/inbound', authenticate, analyticsController.getInboundAnalytics.bind(analyticsController));

/**
 * @route   GET /api/analytics/export
 * @desc    Export analytics data as CSV
 * @access  Private
 */
router.get('/export', authenticate, analyticsController.exportAnalytics.bind(analyticsController));

/**
 * @route   POST /api/analytics/cache/clear
 * @desc    Clear analytics cache (admin only)
 * @access  Private/Admin
 */
router.post('/cache/clear', authenticate, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  analyticsController.clearCache();
  res.json({ success: true, message: 'Analytics cache cleared' });
});

/**
 * @route   GET /api/analytics/health
 * @desc    Health check for analytics service
 * @access  Public
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'analytics',
    timestamp: new Date().toISOString(),
    cacheSize: analyticsController.cache.size
  });
});

export default router;
