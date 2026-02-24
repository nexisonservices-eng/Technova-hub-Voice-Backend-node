// middleware/auth.js
import axios from 'axios';
import logger from '../utils/logger.js';

const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS || 30000);
const MAX_AUTH_CACHE_SIZE = Number(process.env.MAX_AUTH_CACHE_SIZE || 1000);

const tokenAuthCache = new Map();
const pendingIntrospection = new Map();

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

const getAdminBaseUrl = () =>
  String(
    process.env.ADMIN_BACKEND_URL ||
      process.env.ADMIN_API_BASE_URL ||
      process.env.ADMIN_SERVICE_URL ||
      ''
  ).replace(/\/$/, '');

const getTokenUserId = (payload = {}) =>
  payload.userId || payload.id || payload._id || payload.sub || null;

const normalizeAuthenticatedUser = (payload = {}) => {
  const userId = getTokenUserId(payload);
  if (!userId) return null;

  return {
    ...payload,
    userId: String(userId),
    _id: String(userId),
    id: String(userId)
  };
};

const getTokenFromHeader = (authHeader = '') => {
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  return authHeader.slice(7).trim().replace(/^"|"$/g, '') || null;
};

const getCachedUser = (token) => {
  if (!token || AUTH_CACHE_TTL_MS <= 0) return null;

  const cached = tokenAuthCache.get(token);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    tokenAuthCache.delete(token);
    return null;
  }

  return cached.user;
};

const setCachedUser = (token, user) => {
  if (!token || !user || AUTH_CACHE_TTL_MS <= 0) return;

  if (tokenAuthCache.size >= MAX_AUTH_CACHE_SIZE) {
    const oldestKey = tokenAuthCache.keys().next().value;
    if (oldestKey) tokenAuthCache.delete(oldestKey);
  }

  tokenAuthCache.set(token, {
    user,
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS
  });
};

const mapAuthFailure = (error) => {
  if (error instanceof AuthError) return error;

  if (axios.isAxiosError(error)) {
    const status = error.response?.status;

    if (status === 401 || status === 403) {
      return new AuthError('Invalid or expired token', 401);
    }

    if (!error.response) {
      return new AuthError('Authentication service unavailable', 503);
    }

    if (status >= 500) {
      return new AuthError('Authentication service unavailable', 503);
    }
  }

  return new AuthError('Invalid or expired token', 401);
};

const introspectTokenWithAdmin = async (token) => {
  const adminBaseUrl = getAdminBaseUrl();
  if (!adminBaseUrl) {
    throw new AuthError('Authentication service unavailable', 503);
  }

  const headers = {
    Authorization: `Bearer ${token}`
  };

  if (process.env.INTERNAL_API_KEY) {
    headers['x-internal-api-key'] = process.env.INTERNAL_API_KEY;
  }

  try {
    const response = await axios.get(`${adminBaseUrl}/api/user/credentials`, {
      timeout: Number(process.env.ADMIN_API_TIMEOUT_MS || 5000),
      headers
    });

    const normalizedUser = normalizeAuthenticatedUser(
      response?.data?.data || response?.data?.user || response?.data || {}
    );

    if (!normalizedUser) {
      throw new AuthError('Invalid token payload', 401);
    }

    return normalizedUser;
  } catch (error) {
    throw mapAuthFailure(error);
  }
};

export const verifyOrResolveToken = async (token) => {
  const normalizedToken = String(token || '').trim().replace(/^"|"$/g, '');
  if (!normalizedToken) {
    throw new AuthError('Unauthorized', 401);
  }

  const cachedUser = getCachedUser(normalizedToken);
  if (cachedUser) return cachedUser;

  const pending = pendingIntrospection.get(normalizedToken);
  if (pending) return pending;

  const introspectionPromise = introspectTokenWithAdmin(normalizedToken)
    .then((user) => {
      setCachedUser(normalizedToken, user);
      return user;
    })
    .finally(() => {
      pendingIntrospection.delete(normalizedToken);
    });

  pendingIntrospection.set(normalizedToken, introspectionPromise);
  return introspectionPromise;
};

export const verifyAuthToken = async (token) => verifyOrResolveToken(token);

export const authenticate = async (req, res, next) => {
  const token = getTokenFromHeader(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const user = await verifyOrResolveToken(token);
    req.user = user;
    return next();
  } catch (error) {
    const mapped = mapAuthFailure(error);

    if (mapped.status === 503) {
      logger.warn('Auth service unavailable while validating token', {
        path: req.originalUrl,
        method: req.method
      });
      return res.status(503).json({ message: 'Authentication service unavailable' });
    }

    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};
