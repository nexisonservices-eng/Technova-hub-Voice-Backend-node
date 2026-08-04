import BookingSlot from '../models/BookingSlot.js';
import logger from '../utils/logger.js';

export const BOOKING_SLOT_COMPOUND_INDEX_NAME = 'workflowId_1_nodeId_1_slotKey_1_slotDate_1';

const isIndexMissingError = (error = {}) => {
  const code = Number(error?.code);
  const message = String(error?.message || '').toLowerCase();
  return (
    code === 27 ||
    code === 85 ||
    code === 86 ||
    message.includes('index not found') ||
    message.includes('not found with name') ||
    message.includes('index')
  );
};

const getIndexDefinition = async () => {
  const indexes = await BookingSlot.collection.indexes();
  return indexes.find((index) => index.name === BOOKING_SLOT_COMPOUND_INDEX_NAME) || null;
};

export const migrateBookingSlotIndex = async () => {
  const indexDefinition = await getIndexDefinition();
  let removedUniqueIndex = false;
  let alreadyAbsent = false;

  if (indexDefinition?.unique) {
    try {
      await BookingSlot.collection.dropIndex(BOOKING_SLOT_COMPOUND_INDEX_NAME);
      removedUniqueIndex = true;
      logger.info(`Removed unique BookingSlot index: ${BOOKING_SLOT_COMPOUND_INDEX_NAME}`);
    } catch (error) {
      if (isIndexMissingError(error)) {
        alreadyAbsent = true;
        logger.info(`BookingSlot index already absent: ${BOOKING_SLOT_COMPOUND_INDEX_NAME}`);
      } else {
        logger.error(`Failed to drop BookingSlot index ${BOOKING_SLOT_COMPOUND_INDEX_NAME}:`, error);
        throw error;
      }
    }
  } else if (!indexDefinition) {
    alreadyAbsent = true;
    logger.info(`BookingSlot index already absent: ${BOOKING_SLOT_COMPOUND_INDEX_NAME}`);
  } else {
    logger.info(`BookingSlot index already exists as non-unique: ${BOOKING_SLOT_COMPOUND_INDEX_NAME}`);
  }

  const currentIndex = await getIndexDefinition();
  if (!currentIndex || currentIndex.unique) {
    await BookingSlot.collection.createIndex(
      { workflowId: 1, nodeId: 1, slotKey: 1, slotDate: 1 },
      { name: BOOKING_SLOT_COMPOUND_INDEX_NAME, unique: false }
    );
    logger.info(`Created non-unique BookingSlot index: ${BOOKING_SLOT_COMPOUND_INDEX_NAME}`);
    return {
      removedUniqueIndex,
      alreadyAbsent,
      recreatedNonUniqueIndex: true
    };
  }

  return {
    removedUniqueIndex,
    alreadyAbsent,
    recreatedNonUniqueIndex: false
  };
};

export default migrateBookingSlotIndex;
