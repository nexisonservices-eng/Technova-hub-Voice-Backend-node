// middleware/auth.js
import axios from 'axios';
import jwt from 'jsonwebtoken';

const getConfiguredSecrets = () => {
  const secrets = [
    process.env.JWT_SECRET,
    process.env.ADMIN_JWT_SECRET,
    ...String(process.env.JWT_SECRETS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  ].filter(Boolean);

  return [...new Set(secrets)];
};

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

const verifyTokenLocally = (token) => {
  const secrets = getConfiguredSecrets();
  if (!secrets.length) return null;

  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret);
    } catch (error) {
      continue;
    }
  }

  return null;
};

export const verifyAuthToken = (token) => {
  if (!token) {
    throw new Error('Unauthorized');
  }

  const payload = verifyTokenLocally(token);
  if (!payload) {
    throw new Error('Invalid or expired token');
  }

  return payload;
};

const introspectTokenWithAdmin = async (token) => {
  const adminBaseUrl = getAdminBaseUrl();
  if (!adminBaseUrl) return null;

  try {
    const response = await axios.get(`${adminBaseUrl}/api/user/credentials`, {
      timeout: Number(process.env.ADMIN_API_TIMEOUT_MS || 5000),
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const userData = response?.data?.data;
    const userId = userData?.userId;
    if (!userId) return null;

    return {
      userId: String(userId),
      id: String(userId),
      _id: String(userId),
      email: userData?.email || null,
      role: 'admin'
    };
  } catch (error) {
    return null;
  }
};

export const verifyOrResolveToken = async (token) => {
  const localPayload = verifyTokenLocally(token);
  if (localPayload) {
    const normalizedUser = normalizeAuthenticatedUser(localPayload);
    if (!normalizedUser) {
      throw new Error('Invalid token payload');
    }
    return normalizedUser;
  }

  const introspectedUser = await introspectTokenWithAdmin(token);
  if (introspectedUser) {
    return introspectedUser;
  }

  throw new Error('Invalid or expired token');
};

export const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const user = await verifyOrResolveToken(token);
    req.user = user;
    return next();
  } catch (error) {
    if (error.message === 'Invalid token payload') {
      return res.status(401).json({ message: error.message });
    }
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};
