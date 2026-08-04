import 'dotenv/config';
import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import { migrateBookingSlotIndex } from '../migrations/bookingSlotIndexMigration.js';

const run = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set');
  }

  logger.info('Starting BookingSlot index migration...');
  await mongoose.connect(process.env.MONGODB_URI);
  logger.info('Connected to MongoDB for BookingSlot index migration');

  const result = await migrateBookingSlotIndex();
  logger.info('BookingSlot index migration completed', result);
};

run()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error('BookingSlot index migration failed:', error);
    try {
      await mongoose.disconnect();
    } catch {
      // Ignore disconnect failures during migration shutdown.
    }
    process.exit(1);
  });
