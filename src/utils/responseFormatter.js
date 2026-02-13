/**
 * Standardized API Response Formatter
 * Ensures consistent response structure across all endpoints
 */

class ResponseFormatter {
    /**
     * Success response
     * @param {*} data - Response data
     * @param {Object} meta - Optional metadata (pagination, etc.)
     * @returns {Object} Formatted success response
     */
    static success(data, meta = {}) {
        return {
            success: true,
            data,
            error: null,
            meta: {
                timestamp: new Date().toISOString(),
                ...meta
            }
        };
    }

    /**
     * Error response
     * @param {string} message - Error message
     * @param {string} code - Error code
     * @param {*} details - Additional error details
     * @param {number} statusCode - HTTP status code
     * @returns {Object} Formatted error response
     */
    static error(message, code = 'INTERNAL_ERROR', details = null, statusCode = 500) {
        return {
            success: false,
            data: null,
            error: {
                code,
                message,
                details,
                statusCode
            },
            meta: {
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Paginated response
     * @param {Array} data - Array of items
     * @param {number} page - Current page number
     * @param {number} limit - Items per page
     * @param {number} total - Total number of items
     * @returns {Object} Formatted paginated response
     */
    static paginated(data, page, limit, total) {
        const totalPages = Math.ceil(total / limit);

        return {
            success: true,
            data,
            error: null,
            meta: {
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages,
                    hasNextPage: page < totalPages,
                    hasPrevPage: page > 1
                },
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Created response (201)
     * @param {*} data - Created resource data
     * @param {string} resourceId - ID of created resource
     * @returns {Object} Formatted created response
     */
    static created(data, resourceId = null) {
        return {
            success: true,
            data,
            error: null,
            meta: {
                resourceId,
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * No content response (204)
     * @returns {Object} Formatted no content response
     */
    static noContent() {
        return {
            success: true,
            data: null,
            error: null,
            meta: {
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Validation error response
     * @param {Array} errors - Array of validation errors
     * @returns {Object} Formatted validation error response
     */
    static validationError(errors) {
        return {
            success: false,
            data: null,
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Validation failed',
                details: errors,
                statusCode: 400
            },
            meta: {
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Unauthorized response
     * @param {string} message - Error message
     * @returns {Object} Formatted unauthorized response
     */
    static unauthorized(message = 'Unauthorized access') {
        return {
            success: false,
            data: null,
            error: {
                code: 'UNAUTHORIZED',
                message,
                details: null,
                statusCode: 401
            },
            meta: {
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Not found response
     * @param {string} resource - Resource type that was not found
     * @returns {Object} Formatted not found response
     */
    static notFound(resource = 'Resource') {
        return {
            success: false,
            data: null,
            error: {
                code: 'NOT_FOUND',
                message: `${resource} not found`,
                details: null,
                statusCode: 404
            },
            meta: {
                timestamp: new Date().toISOString()
            }
        };
    }
}

export default ResponseFormatter;
