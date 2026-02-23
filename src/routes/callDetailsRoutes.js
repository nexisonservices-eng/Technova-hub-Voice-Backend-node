import express from 'express';
import callDetailsController from '../controllers/callDetailsController.js';
import { authenticate } from '../middleware/auth.js';
import { resolveUserTwilioContext } from '../middleware/userTwilioContext.js';

const router = express.Router();

/**
 * @route   GET /api/calls
 * @desc    Get all calls with filtering and pagination
 * @query   type, status, startDate, endDate, phoneNumber, page, limit, sortBy, sortOrder
 * @access  Private
 */
router.get('/', authenticate, resolveUserTwilioContext, callDetailsController.getAllCalls.bind(callDetailsController));

/**
 * @route   GET /api/calls/:callId
 * @desc    Get detailed information for a specific call
 * @query   type (inbound, ivr, outbound)
 * @access  Private
 */
router.get('/:callId', authenticate, resolveUserTwilioContext, callDetailsController.getCallDetails.bind(callDetailsController));

/**
 * @route   GET /api/calls/:callId/inbound
 * @desc    Get detailed inbound call information
 * @access  Private
 */
router.get('/:callId/inbound', authenticate, resolveUserTwilioContext, callDetailsController.getInboundDetails.bind(callDetailsController));

/**
 * @route   GET /api/calls/:callId/ivr
 * @desc    Get detailed IVR workflow execution details
 * @access  Private
 */
router.get('/:callId/ivr', authenticate, resolveUserTwilioContext, callDetailsController.getIVRDetails.bind(callDetailsController));

/**
 * @route   GET /api/calls/:callId/outbound
 * @desc    Get detailed outbound call information
 * @access  Private
 */
router.get('/:callId/outbound', authenticate, resolveUserTwilioContext, callDetailsController.getOutboundDetails.bind(callDetailsController));


export default router;
