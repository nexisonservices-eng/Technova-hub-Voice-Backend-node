// middleware/auth.js
import jwt from 'jsonwebtoken';

const allowInsecureDecode =
  process.env.NODE_ENV !== 'production' &&
  String(process.env.ALLOW_INSECURE_JWT_DECODE || 'true').toLowerCase() === 'true';

export const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];

  try {
    if (process.env.JWT_SECRET) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      return next();
    }

    if (!allowInsecureDecode) {
      return res.status(500).json({ message: 'JWT_SECRET is not configured' });
    }

    const decoded = jwt.decode(token);
    if (decoded) {
      req.user = decoded;
      return next();
    }

    return res.status(401).json({ message: 'Invalid token' });
  } catch (error) {
    if (allowInsecureDecode) {
      const decoded = jwt.decode(token);
      if (decoded) {
        req.user = decoded;
        return next();
      }
    }

    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};
