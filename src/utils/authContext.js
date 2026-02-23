import mongoose from 'mongoose';

export const getRawUserId = (user) =>
  user?.userId || user?._id || user?.id || user?.sub || null;

export const getUserIdString = (req) => {
  const raw = getRawUserId(req?.user);
  if (!raw) return null;
  return String(raw);
};

export const getUserObjectId = (req) => {
  const userId = getUserIdString(req);
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }
  return new mongoose.Types.ObjectId(userId);
};
