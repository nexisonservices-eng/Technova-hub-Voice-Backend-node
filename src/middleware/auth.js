// middleware/auth.js
import jwt from 'jsonwebtoken';

export const authenticate = (req, res, next) => {
  // --- DEV MODE BYPASS ---
  // req.user = { id: 'dev-user', role: ' admin' };
  // req.user = { id: '507f1f77bcf86cd799439011', _id: '507f1f77bcf86cd799439011', role: 'admin' };
  // return next();

  /* 
  // Production Auth Logic - Enabled for Live Deployment
  */
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // attach user info to request
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};
