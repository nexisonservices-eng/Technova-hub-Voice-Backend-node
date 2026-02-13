/**
 * Validation Middleware
 * Validates request data against defined schemas
 */

/**
 * IVR Menu Validation Schema
 */
const ivrMenuSchema = {
    greeting: {
        type: 'string',
        required: true,
        minLength: 10,
        maxLength: 500,
        message: 'Greeting must be between 10 and 500 characters'
    },
    menu: {
        type: 'array',
        required: true,
        minItems: 1,
        maxItems: 9,
        message: 'Menu must have between 1 and 9 options',
        itemSchema: {
            key: {
                type: 'string',
                required: true,
                pattern: /^[0-9]$/,
                message: 'Menu key must be a single digit (0-9)'
            },
            text: {
                type: 'string',
                required: true,
                minLength: 5,
                maxLength: 200,
                message: 'Menu option text must be between 5 and 200 characters'
            },
            action: {
                type: 'string',
                required: true,
                enum: ['route_to_sales', 'route_to_tech', 'route_to_billing', 'route_to_ai', 'voicemail', 'transfer', 'callback'],
                message: 'Invalid menu action'
            }
        }
    },
    timeout: {
        type: 'number',
        required: false,
        min: 3,
        max: 30,
        message: 'Timeout must be between 3 and 30 seconds'
    },
    maxAttempts: {
        type: 'number',
        required: false,
        min: 1,
        max: 5,
        message: 'Max attempts must be between 1 and 5'
    },
    invalidInputMessage: {
        type: 'string',
        required: false,
        maxLength: 200,
        message: 'Invalid input message must be under 200 characters'
    }
};

/**
 * Phone Number Validation Pattern
 */
const phoneRegex = /^\+?[1-9]\d{1,14}$/; // E.164 format

/**
 * Call Log Filter Schema
 */
const callLogFilterSchema = {
    startDate: {
        type: 'date',
        required: false,
        message: 'Invalid start date format'
    },
    endDate: {
        type: 'date',
        required: false,
        message: 'Invalid end date format'
    },
    status: {
        type: 'string',
        required: false,
        enum: ['initiated', 'ringing', 'in-progress', 'completed', 'failed', 'busy', 'no-answer', 'cancelled'],
        message: 'Invalid call status'
    },
    direction: {
        type: 'string',
        required: false,
        enum: ['inbound', 'outbound'],
        message: 'Direction must be inbound or outbound'
    },
    phoneNumber: {
        type: 'string',
        required: false,
        pattern: phoneRegex,
        message: 'Invalid phone number format (use E.164 format)'
    },
    page: {
        type: 'number',
        required: false,
        min: 1,
        message: 'Page must be >= 1'
    },
    limit: {
        type: 'number',
        required: false,
        min: 1,
        max: 100,
        message: 'Limit must be between 1 and 100'
    }
};

/**
 * Outbound Campaign Schema
 */
const outboundCampaignSchema = {
    name: {
        type: 'string',
        required: true,
        minLength: 3,
        maxLength: 100,
        message: 'Campaign name must be between 3 and 100 characters'
    },
    phoneNumbers: {
        type: 'array',
        required: true,
        minItems: 1,
        maxItems: 1000,
        message: 'Must provide 1-1000 phone numbers',
        itemPattern: phoneRegex,
        itemMessage: 'Invalid phone number format (use E.164 format)'
    },
    greeting: {
        type: 'string',
        required: false,
        maxLength: 500,
        message: 'Greeting must be under 500 characters'
    },
    scheduledTime: {
        type: 'date',
        required: false,
        futureOnly: true,
        message: 'Scheduled time must be in the future'
    }
};

/**
 * Validate a value against a field schema
 */
function validateField(value, fieldSchema, fieldName) {
    const errors = [];

    // Required check
    if (fieldSchema.required && (value === undefined || value === null || value === '')) {
        errors.push({
            field: fieldName,
            message: `${fieldName} is required`
        });
        return errors;
    }

    // Skip further validation if field is optional and not provided
    if (!fieldSchema.required && (value === undefined || value === null || value === '')) {
        return errors;
    }

    // Type check
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (fieldSchema.type === 'date') {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
            errors.push({
                field: fieldName,
                message: fieldSchema.message || `${fieldName} must be a valid date`
            });
            return errors;
        }

        // Future only check
        if (fieldSchema.futureOnly && date <= new Date()) {
            errors.push({
                field: fieldName,
                message: fieldSchema.message || `${fieldName} must be in the future`
            });
        }
    } else if (actualType !== fieldSchema.type) {
        errors.push({
            field: fieldName,
            message: `${fieldName} must be of type ${fieldSchema.type}`
        });
        return errors;
    }

    // String validations
    if (fieldSchema.type === 'string') {
        if (fieldSchema.minLength && value.length < fieldSchema.minLength) {
            errors.push({
                field: fieldName,
                message: fieldSchema.message || `${fieldName} must be at least ${fieldSchema.minLength} characters`
            });
        }
        if (fieldSchema.maxLength && value.length > fieldSchema.maxLength) {
            errors.push({
                field: fieldName,
                message: fieldSchema.message || `${fieldName} must be at most ${fieldSchema.maxLength} characters`
            });
        }
        if (fieldSchema.pattern && !fieldSchema.pattern.test(value)) {
            errors.push({
                field: fieldName,
                message: fieldSchema.message || `${fieldName} has invalid format`
            });
        }
        if (fieldSchema.enum && !fieldSchema.enum.includes(value)) {
            errors.push({
                field: fieldName,
                message: fieldSchema.message || `${fieldName} must be one of: ${fieldSchema.enum.join(', ')}`
            });
        }
    }

    // Number validations
    if (fieldSchema.type === 'number') {
        const numValue = Number(value);
        if (isNaN(numValue)) {
            errors.push({
                field: fieldName,
                message: `${fieldName} must be a valid number`
            });
            return errors;
        }
        if (fieldSchema.min !== undefined && numValue < fieldSchema.min) {
            errors.push({
                field: fieldName,
                message: fieldSchema.message || `${fieldName} must be >= ${fieldSchema.min}`
            });
        }
        if (fieldSchema.max !== undefined && numValue > fieldSchema.max) {
            errors.push({
                field: fieldName,
                message: fieldSchema.message || `${fieldName} must be <= ${fieldSchema.max}`
            });
        }
    }

    // Array validations
    if (fieldSchema.type === 'array') {
        if (fieldSchema.minItems && value.length < fieldSchema.minItems) {
            errors.push({
                field: fieldName,
                message: fieldSchema.message || `${fieldName} must have at least ${fieldSchema.minItems} items`
            });
        }
        if (fieldSchema.maxItems && value.length > fieldSchema.maxItems) {
            errors.push({
                field: fieldName,
                message: fieldSchema.message || `${fieldName} must have at most ${fieldSchema.maxItems} items`
            });
        }

        // Validate array items
        if (fieldSchema.itemSchema) {
            value.forEach((item, index) => {
                Object.keys(fieldSchema.itemSchema).forEach(key => {
                    const itemErrors = validateField(item[key], fieldSchema.itemSchema[key], `${fieldName}[${index}].${key}`);
                    errors.push(...itemErrors);
                });
            });
        }

        // Validate array item patterns
        if (fieldSchema.itemPattern) {
            value.forEach((item, index) => {
                if (!fieldSchema.itemPattern.test(item)) {
                    errors.push({
                        field: `${fieldName}[${index}]`,
                        message: fieldSchema.itemMessage || `Invalid format for ${fieldName} item`
                    });
                }
            });
        }
    }

    return errors;
}

/**
 * Validate data against a schema
 */
function validateSchema(data, schema) {
    const errors = [];

    Object.keys(schema).forEach(fieldName => {
        const fieldErrors = validateField(data[fieldName], schema[fieldName], fieldName);
        errors.push(...fieldErrors);
    });

    return errors;
}

/**
 * Middleware factory for validation
 */
export function validate(schemaName) {
    const schemas = {
        ivrMenu: ivrMenuSchema,
        callLogFilter: callLogFilterSchema,
        outboundCampaign: outboundCampaignSchema
    };

    return (req, res, next) => {
        const schema = schemas[schemaName];

        if (!schema) {
            return res.status(500).json({
                success: false,
                error: {
                    code: 'INTERNAL_ERROR',
                    message: 'Invalid validation schema',
                    details: null
                }
            });
        }

        const dataToValidate = req.method === 'GET' ? req.query : req.body;
        const errors = validateSchema(dataToValidate, schema);

        if (errors.length > 0) {
            return res.status(400).json({
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
            });
        }

        next();
    };
}

/**
 * Phone number validation middleware
 */
export function validatePhoneNumber(field = 'phoneNumber') {
    return (req, res, next) => {
        const phoneNumber = req.body[field] || req.params[field] || req.query[field];

        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: `${field} is required`,
                    details: [{ field, message: `${field} is required` }],
                    statusCode: 400
                }
            });
        }

        if (!phoneRegex.test(phoneNumber)) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid phone number format',
                    details: [{ field, message: 'Phone number must be in E.164 format (e.g., +14155552671)' }],
                    statusCode: 400
                }
            });
        }

        next();
    };
}

export default {
    validate,
    validatePhoneNumber,
    validateSchema
};
