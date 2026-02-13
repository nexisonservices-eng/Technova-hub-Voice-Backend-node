import broadcastService from '../services/broadcastService.js';
import Broadcast from '../models/Broadcast.js';
import BroadcastCall from '../models/BroadcastCall.js';
import { validateTemplate } from '../utils/messagePersonalizer.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';

/**
 * Helper function to extract user ID from request
 */
const extractUserId = (req) => {
  // Try different possible user ID fields from JWT token
  const userId = req.user?._id || req.user?.id || req.user?.sub || req.user?.userId;
  
  if (userId) {
    // If it's already a valid ObjectId, return it
    if (mongoose.Types.ObjectId.isValid(userId)) {
      return userId;
    }
    // If it's a string, try to convert to ObjectId
    try {
      return new mongoose.Types.ObjectId(userId);
    } catch (error) {
      logger.warn('Invalid user ID format, using fallback:', userId);
    }
  }
  
  // Fallback for development/testing
  logger.warn('No valid user ID found, using system fallback');
  return new mongoose.Types.ObjectId(); // Generate a valid ObjectId for testing
};

class BroadcastController {
  /**
   * POST /broadcast/start
   * Create and start broadcast campaign
   */
  async startBroadcast(req, res) {
    try {
      const {
        name,
        messageTemplate,
        voice,
        contacts,
        maxConcurrent,
        maxRetries,
        compliance
      } = req.body;

      // Validate template
      const templateValidation = validateTemplate(messageTemplate);
      if (!templateValidation.valid) {
        return res.status(400).json({
          error: 'Invalid message template',
          details: templateValidation.errors
        });
      }

      // Validate contacts
      if (!contacts || contacts.length === 0) {
        return res.status(400).json({
          error: 'No contacts provided'
        });
      }

      if (contacts.length > 10000) {
        return res.status(400).json({
          error: 'Maximum 10,000 contacts per broadcast'
        });
      }

      // Create broadcast
      const broadcast = await broadcastService.createBroadcast(
        {
          name,
          messageTemplate,
          voice,
          contacts,
          maxConcurrent,
          maxRetries,
          compliance
        },
        extractUserId(req)
      );

      // Start broadcast asynchronously
      broadcastService.startBroadcast(broadcast._id).catch(error => {
        logger.error(
          `Failed to start broadcast ${broadcast._id}:`,
          error
        );
      });

      res.status(201).json({
        success: true,
        broadcast: {
          id: broadcast._id,
          name: broadcast.name,
          status: broadcast.status,
          totalContacts: broadcast.contacts.length
        }
      });
    } catch (error) {
      logger.error('Start broadcast error:', error);
      res.status(500).json({
        error: 'Failed to start broadcast',
        message: error.message
      });
    }
  }

  /**
   * GET /broadcast/status/:id
   * Get real-time broadcast status
   */
  async getBroadcastStatus(req, res) {
    try {
      const { id } = req.params;

      const broadcast = await broadcastService.getBroadcastStatus(id);

      res.json({
        success: true,
        broadcast: {
          id: broadcast._id,
          name: broadcast.name,
          status: broadcast.status,
          stats: broadcast.stats,
          startedAt: broadcast.startedAt,
          completedAt: broadcast.completedAt,
          config: broadcast.config
        }
      });
    } catch (error) {
      logger.error('Get broadcast status error:', error);
      res.status(500).json({
        error: 'Failed to get broadcast status',
        message: error.message
      });
    }
  }

  /**
   * POST /broadcast/:id/cancel
   * Cancel ongoing broadcast
   */
  async cancelBroadcast(req, res) {
    try {
      const { id } = req.params;

      const broadcast = await broadcastService.cancelBroadcast(id);

      res.json({
        success: true,
        message: 'Broadcast cancelled',
        broadcast: {
          id: broadcast._id,
          status: broadcast.status,
          stats: broadcast.stats
        }
      });
    } catch (error) {
      logger.error('Cancel broadcast error:', error);
      res.status(500).json({
        error: 'Failed to cancel broadcast',
        message: error.message
      });
    }
  }

  /**
   * GET /broadcast/:id/calls
   * Get individual call details
   */
  async getBroadcastCalls(req, res) {
    try {
      const { id } = req.params;
      const { status, page = 1, limit = 50 } = req.query;

      const query = { broadcast: id };
      if (status) {
        query.status = status;
      }

      const parsedLimit = parseInt(limit, 10);
      const parsedPage = parseInt(page, 10);

      const calls = await BroadcastCall.find(query)
        .sort({ createdAt: -1 })
        .limit(parsedLimit)
        .skip((parsedPage - 1) * parsedLimit)
        .lean();

      const total = await BroadcastCall.countDocuments(query);

      res.json({
        success: true,
        calls,
        pagination: {
          page: parsedPage,
          limit: parsedLimit,
          total,
          pages: Math.ceil(total / parsedLimit)
        }
      });
    } catch (error) {
      logger.error('Get broadcast calls error:', error);
      res.status(500).json({
        error: 'Failed to get broadcast calls',
        message: error.message
      });
    }
  }

  /**
   * GET /broadcast/list
   * List all broadcasts
   */
  async listBroadcasts(req, res) {
    try {
      const { status, page = 1, limit = 20 } = req.query;

      const query = { createdBy: extractUserId(req) };
      if (status) {
        query.status = status;
      }

      const parsedLimit = parseInt(limit, 10);
      const parsedPage = parseInt(page, 10);

      const broadcasts = await Broadcast.find(query)
        .sort({ createdAt: -1 })
        .limit(parsedLimit)
        .skip((parsedPage - 1) * parsedLimit)
        .select('-contacts -audioAssets')
        .lean();

      const total = await Broadcast.countDocuments(query);

      res.json({
        success: true,
        broadcasts,
        pagination: {
          page: parsedPage,
          limit: parsedLimit,
          total,
          pages: Math.ceil(total / parsedLimit)
        }
      });
    } catch (error) {
      logger.error('List broadcasts error:', error);
      res.status(500).json({
        error: 'Failed to list broadcasts',
        message: error.message
      });
    }
  }

  /**
   * DELETE /broadcast/:id
   * Delete broadcast and history
   */
  async deleteBroadcast(req, res) {
    try {
      const { id } = req.params;
      await broadcastService.deleteBroadcast(id);

      res.json({
        success: true,
        message: 'Broadcast deleted successfully'
      });
    } catch (error) {
      logger.error('Delete broadcast error:', error);
      res.status(500).json({
        error: 'Failed to delete broadcast',
        message: error.message
      });
    }
  }
}

export default new BroadcastController();