import mongoose from 'mongoose';
import logger from '../utils/logger.js';

export const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set');
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    logger.info('✓ MongoDB connected successfully');
    logger.info(`  Database: ${mongoose.connection.name}`);
    logger.info(`  Host: ${mongoose.connection.host}`);

    if (!mongoose.connection.listeners('error').length) {
      mongoose.connection.on('error', err =>
        logger.error('MongoDB connection error:', err)
      );
      mongoose.connection.on('disconnected', () =>
        logger.warn('MongoDB disconnected')
      );
      mongoose.connection.on('reconnected', () =>
        logger.info('MongoDB reconnected')
      );
    }
  } catch (error) {
    logger.error('MongoDB connection failed:', error);
    process.exit(1);
  }
};

export const closeDB = async () => {
  await mongoose.connection.close();
  logger.info('MongoDB connection closed');
};
