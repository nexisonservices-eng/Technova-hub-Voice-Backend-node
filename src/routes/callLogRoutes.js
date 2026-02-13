/**
 * Call Log Routes
 * RESTful API for call log management
 */
import express from 'express';
import CallLogController from '../controllers/callLogController.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

/**
 * @route GET /api/call-logs
 * @desc Get call logs with filtering and pagination
 * @access Private
 */
router.get('/', validate('callLogFilter'), CallLogController.getCallLogs.bind(CallLogController));

/**
 * @route GET /api/call-logs/stats
 * @desc Get call statistics
 * @access Private
 */
router.get('/stats', CallLogController.getCallStats.bind(CallLogController));

/**
 * @route GET /api/call-logs/export
 * @desc Export call logs as CSV or JSON
 * @access Private
 */
router.get('/export', validate('callLogFilter'), CallLogController.exportCallLogs.bind(CallLogController));

/**
 * @route GET /api/call-logs/:callSid
 * @desc Get single call details
 * @access Private
 */
router.get('/:callSid', CallLogController.getCallDetails.bind(CallLogController));

/**
 * @route DELETE /api/call-logs/:callSid
 * @desc Soft delete a call log
 * @access Private
 */
router.delete('/:callSid', CallLogController.deleteCallLog.bind(CallLogController));

/**
 * @route POST /api/call-logs/bulk-delete
 * @desc Bulk delete call logs
 * @access Private
 */
router.post('/bulk-delete', CallLogController.bulkDeleteCallLogs.bind(CallLogController));

/**
 * @route POST /api/call-logs/:callSid/tags
 * @desc Add tags to a call log
 * @access Private
 */
router.post('/:callSid/tags', CallLogController.addTags.bind(CallLogController));

export default router;
