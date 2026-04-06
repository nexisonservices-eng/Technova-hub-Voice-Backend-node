import logger from './logger.js';
import cloudinary from './cloudinaryUtils.js';
import adminCredentialsService from '../services/adminCredentialsService.js';

const ROOT_PREFIX = 'technova';
const ensuredFolderCache = new Set();

const sanitizeFolderSegment = (value = '', fallback = 'user') => {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return cleaned || fallback;
};

const toUserIdString = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    if (value.userId) return String(value.userId).trim();
    if (value._id) return String(value._id).trim();
    if (value.id) return String(value.id).trim();
    if (value.sub) return String(value.sub).trim();
  }
  return '';
};

const toUsername = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return String(value.username || '').trim();
  return '';
};

const buildMissingContextError = (message) => {
  const error = new Error(message);
  error.code = 'AUDIO_FOLDER_CONTEXT_MISSING';
  return error;
};

const resolveUserIdentity = async (context = {}) => {
  const userId = toUserIdString(context.userId || context.id || context._id || context.sub || context.user);
  let username = toUsername(context.username);

  if (!userId) {
    throw buildMissingContextError('Unable to resolve userId for Cloudinary audio folder');
  }

  if (!username) {
    const profile = await adminCredentialsService.getUserProfileByUserId(userId);
    username = String(profile?.username || '').trim();
  }

  if (!username) {
    throw buildMissingContextError(`Unable to resolve username for Cloudinary audio folder (userId=${userId})`);
  }

  return {
    userId,
    username,
    userSlug: sanitizeFolderSegment(username, 'user')
  };
};

const createFolderIfMissing = async (folder) => {
  try {
    await cloudinary.api.create_folder(folder);
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    if (!message.includes('already exists')) {
      throw error;
    }
  }
};

export const ensureUserAudioFolders = async (context = {}) => {
  const identity = await resolveUserIdentity(context);
  const root = `${ROOT_PREFIX}/${identity.userSlug}_${identity.userId}`;
  const audioRoot = `${root}/audio`;
  const ivrAudioFolder = `${audioRoot}/ivr-audio`;
  const broadcastAudioFolder = `${audioRoot}/broadcast-audio`;
  const cacheKey = `${identity.userId}:${identity.userSlug}`;

  if (!ensuredFolderCache.has(cacheKey)) {
    await createFolderIfMissing(root);
    await createFolderIfMissing(audioRoot);
    await createFolderIfMissing(ivrAudioFolder);
    await createFolderIfMissing(broadcastAudioFolder);
    ensuredFolderCache.add(cacheKey);
    logger.info(`Ensured Cloudinary user audio folders for ${identity.username} (${identity.userId})`);
  }

  return {
    ...identity,
    root,
    audioRoot,
    ivrAudioFolder,
    broadcastAudioFolder
  };
};

export const resolveCloudinaryAudioFolder = async (context = {}, audioType = 'ivr') => {
  const folders = await ensureUserAudioFolders(context);
  if (audioType === 'broadcast') return folders.broadcastAudioFolder;
  return folders.ivrAudioFolder;
};

