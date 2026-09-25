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

// Use only in read queries. Creation and mutations keep the actual actor ID.
export const getReadUserObjectId = (req) => {
  const ownId = getUserObjectId(req);
  if (!ownId) return null;
  const role = String(req.user?.companyRole || req.user?.role || '').toLowerCase();
  if (!['admin', 'manager'].includes(role)) return ownId;
  const ids = [...new Set([String(ownId), ...(req.user?.workspaceReadUserIds || [])])]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  return ids.length > 1 ? { $in: ids } : ownId;
};
