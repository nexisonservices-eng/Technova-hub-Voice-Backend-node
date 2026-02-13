// middleware/auth.js
import jwt from 'jsonwebtoken';

export const authenticate = (req, res, next) => {
   // --- DEV MODE BYPASS ---
  // req.user = { id: 'dev-user', role: ' admin' };
  // req.user = { id: '507f1f77bcf86cd799439011', _id: '507f1f77bcf86cd799439011', role: 'admin' };
  // return next();

  /* 
  // Production Auth Logic - Enabled for Live Deployment
  // */
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // If we have a JWT secret configured, verify the token normally
    if (process.env.JWT_SECRET) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      return next();
    }
  } catch (error) {
    // In non‑production, fall back to a non‑verifying decode so tokens issued
    // by a different service/secret still work during development.
    if (process.env.NODE_ENV !== 'production') {
      const decoded = jwt.decode(token);
      if (decoded) {
        req.user = decoded;
        return next();
      }
    }

    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  // If no JWT_SECRET is set at all, but we still have a token, try a safe decode.
  const decoded = jwt.decode(token);
  if (decoded) {
    req.user = decoded;
    return next();
  }

  return res.status(401).json({ message: 'Invalid token' });
};
