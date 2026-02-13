import logger from './logger.js';

/**
 * Centralized error handling utility for controllers
 * Reduces duplicate error handling patterns
 */
export class ControllerErrorHandler {
  /**
   * Standard error response format
   */
  static createErrorResponse(message, statusCode = 500, details = null) {
    return {
      success: false,
      error: {
        message,
        statusCode,
        details,
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * Handle async route errors
   */
  static asyncHandler(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(error => {
        this.handleError(error, req, res);
      });
    };
  }

  /**
   * Centralized error handling
   */
  static handleError(error, req, res) {
    logger.error('Controller Error:', {
      error: error.message,
      stack: error.stack,
      url: req.url,
      method: req.method,
      body: req.body
    });

    // Handle specific error types
    if (error.name === 'ValidationError') {
      return this.handleValidationError(error, res);
    }

    if (error.name === 'CastError') {
      return this.handleCastError(error, res);
    }

    if (error.code === 11000) {
      return this.handleDuplicateKeyError(error, res);
    }

    // Default error
    const errorResponse = this.createErrorResponse(error.message);
    res.status(errorResponse.error.statusCode).json(errorResponse);
  }

  /**
   * Handle validation errors
   */
  static handleValidationError(error, res) {
    const errors = Object.values(error.errors).map(err => ({
      field: err.path,
      message: err.message,
      value: err.value
    }));

    const errorResponse = this.createErrorResponse(
      'Validation failed',
      400,
      { errors }
    );

    res.status(errorResponse.error.statusCode).json(errorResponse);
  }

  /**
   * Handle cast errors (invalid ObjectId)
   */
  static handleCastError(error, res) {
    const errorResponse = this.createErrorResponse(
      'Invalid ID format',
      400,
      { field: error.path, value: error.value }
    );

    res.status(errorResponse.error.statusCode).json(errorResponse);
  }

  /**
   * Handle duplicate key errors
   */
  static handleDuplicateKeyError(error, res) {
    const field = Object.keys(error.keyValue)[0];
    const value = error.keyValue[field];

    const errorResponse = this.createErrorResponse(
      'Duplicate entry',
      409,
      { field, value }
    );

    res.status(errorResponse.error.statusCode).json(errorResponse);
  }

  /**
   * Standard success response
   */
  static createSuccessResponse(data = null, message = 'Success', statusCode = 200) {
    return {
      success: true,
      message,
      data,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Send success response
   */
  static sendSuccess(res, data = null, message = 'Success', statusCode = 200) {
    const response = this.createSuccessResponse(data, message, statusCode);
    res.status(statusCode).json(response);
  }

  /**
   * Send error response
   */
  static sendError(res, message, statusCode = 500, details = null) {
    const response = this.createErrorResponse(message, statusCode, details);
    res.status(statusCode).json(response);
  }
}

export default ControllerErrorHandler;
