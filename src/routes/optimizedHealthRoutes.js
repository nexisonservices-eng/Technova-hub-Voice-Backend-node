import express from 'express';
import AIBridgeService from '../services/aiBridgeService.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Cache for health check results
const healthCache = {
  basic: null,
  detailed: null,
  lastUpdate: 0,
  CACHE_DURATION: {
    BASIC: 5000,      // 5 seconds for basic checks
    DETAILED: 30000   // 30 seconds for detailed checks
  }
};

// Rate limiting for health checks
const healthCheckRateLimit = new Map();
const RATE_LIMIT_WINDOW = 1000; // 1 second
const MAX_REQUESTS_PER_WINDOW = 10;

// Request rate limiter
const checkRateLimit = (req) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const requests = healthCheckRateLimit.get(clientIP) || [];
  
  // Clean old requests
  const validRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (validRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  
  validRequests.push(now);
  healthCheckRateLimit.set(clientIP, validRequests);
  return true;
};

// Basic health check - ultra lightweight for load balancers
router.get('/ping', (req, res) => {
  try {
    if (!checkRateLimit(req)) {
      return res.status(429).json({ 
        status: 'error', 
        message: 'Too many health check requests' 
      });
    }

    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'voice-automation-backend',
      version: '1.0.0'
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Internal server error'
    });
  }
});

// Load balancer specific health check - fast and reliable
router.get('/lb', (req, res) => {
  try {
    if (!checkRateLimit(req)) {
      return res.status(429).json({ 
        status: 'error', 
        message: 'Rate limited' 
      });
    }

    // Check if server can handle basic operations
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memoryUsage.heapTotal / 1024 / 1024);
    
    // Fail if memory usage is critical (>90%)
    const memoryUsagePercent = (heapUsedMB / heapTotalMB) * 100;
    const isMemoryCritical = memoryUsagePercent > 90;

    const status = isMemoryCritical ? 'degraded' : 'healthy';
    const statusCode = isMemoryCritical ? 200 : 200; // Still return 200 for LB but mark degraded

    res.status(statusCode).json({
      status,
      timestamp: new Date().toISOString(),
      checks: {
        server: 'healthy',
        memory: {
          used_mb: heapUsedMB,
          total_mb: heapTotalMB,
          usage_percent: Math.round(memoryUsagePercent),
          status: isMemoryCritical ? 'critical' : 'ok'
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    });
  }
});

// Basic health check with caching
router.get('/basic', async (req, res) => {
  try {
    if (!checkRateLimit(req)) {
      return res.status(429).json({ 
        status: 'error', 
        message: 'Too many health check requests' 
      });
    }

    const now = Date.now();
    
    // Return cached result if still valid
    if (healthCache.basic && (now - healthCache.lastUpdate) < healthCache.CACHE_DURATION.BASIC) {
      return res.status(200).json(healthCache.basic);
    }

    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      checks: {
        server: 'healthy',
        memory: {
          used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          status: 'ok'
        },
        uptime: Math.round(process.uptime())
      }
    };

    // Update cache
    healthCache.basic = health;
    healthCache.lastUpdate = now;

    res.status(200).json(health);
  } catch (error) {
    logger.error('Basic health check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Comprehensive health check with longer cache and timeouts
router.get('/detailed', async (req, res) => {
  try {
    if (!checkRateLimit(req)) {
      return res.status(429).json({ 
        status: 'error', 
        message: 'Too many health check requests' 
      });
    }

    const now = Date.now();
    
    // Return cached result if still valid
    if (healthCache.detailed && (now - healthCache.lastUpdate) < healthCache.CACHE_DURATION.DETAILED) {
      return res.status(200).json(healthCache.detailed);
    }

    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      checks: {
        server: 'healthy',
        ai: 'unknown',
        database: 'unknown',
        sockets: {
          active_connections: 0,
          status: 'unknown'
        },
        memory: {
          used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          status: 'ok'
        },
        uptime: Math.round(process.uptime())
      }
    };

    // Check AI service with shorter timeout
    const aiCheckPromise = AIBridgeService.checkHealth();
    const aiTimeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('AI health check timeout')), 2000)
    );

    try {
      const aiHealth = await Promise.race([aiCheckPromise, aiTimeoutPromise]);
      health.checks.ai = aiHealth.status === 'ok' ? 'healthy' : 'unhealthy';
      if (aiHealth.status === 'ok') {
        logger.debug('✓ AI service health check passed');
      } else {
        logger.warn(`AI service degraded: ${aiHealth.error || 'Unknown error'}`);
      }
    } catch (error) {
      health.checks.ai = 'unhealthy';
      health.ai_error = error.message;
      if (error.message.includes('timeout')) {
        logger.warn('AI service health check timeout');
      } else {
        logger.error(`AI service health check failed: ${error.message}`);
      }
    }

    // Check database with timeout
    try {
      // Add your database health check here with timeout
      const dbCheckPromise = new Promise((resolve) => {
        // Replace with actual database check
        setTimeout(() => resolve({ connected: true }), 100);
      });
      
      const dbTimeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Database health check timeout')), 1500)
      );
      
      await Promise.race([dbCheckPromise, dbTimeoutPromise]);
      health.checks.database = 'healthy';
    } catch (error) {
      health.checks.database = 'unhealthy';
      health.db_error = error.message;
      logger.error(`Database health check failed: ${error.message}`);
    }

    // Determine overall status
    const criticalServices = ['server', 'database'];
    const criticalStatus = criticalServices.every(service => 
      health.checks[service] === 'healthy'
    ) ? 'healthy' : 'unhealthy';

    const optionalServices = ['ai', 'sockets'];
    const optionalStatus = optionalServices.every(service => {
      const serviceStatus = typeof health.checks[service] === 'string' 
        ? health.checks[service] 
        : health.checks[service].status;
      return serviceStatus === 'healthy';
    });

    health.status = criticalStatus === 'healthy' 
      ? (optionalStatus ? 'healthy' : 'degraded')
      : 'unhealthy';
    
    const statusCode = health.status === 'healthy' ? 200 : 
                       health.status === 'degraded' ? 200 : 503;

    // Update cache
    healthCache.detailed = health;
    healthCache.lastUpdate = now;

    res.status(statusCode).json(health);

  } catch (error) {
    logger.error('Detailed health check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Legacy health check endpoint - redirect to detailed
router.get('/', (req, res) => {
  res.redirect(307, '/detailed');
});

// Ready check for Kubernetes/Docker
router.get('/ready', async (req, res) => {
  try {
    // Check if all critical services are ready
    const health = {
      status: 'ready',
      timestamp: new Date().toISOString(),
      checks: {
        server: 'ready',
        database: 'ready' // Add actual database check
      }
    };

    // Check database connection quickly
    try {
      // Add your database readiness check here
      health.checks.database = 'ready';
    } catch (error) {
      health.checks.database = 'not_ready';
      health.status = 'not_ready';
    }

    const statusCode = health.status === 'ready' ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    res.status(500).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Live check for Kubernetes/Docker
router.get('/live', (req, res) => {
  try {
    // Basic liveness check - if this responds, the process is alive
    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime())
    });
  } catch (error) {
    res.status(500).json({
      status: 'not_alive',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

export default router;
