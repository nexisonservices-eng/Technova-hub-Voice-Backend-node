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

const buildCompanyRoot = ({ companyName = '', companySlug = '', companyId = '' }) => {
  const safeCompanyId = String(companyId || '').trim();
  if (!safeCompanyId) return '';
  const companySlugSegment = sanitizeFolderSegment(companySlug || companyName || '', 'company');
  return `${ROOT_PREFIX}/${companySlugSegment}_${safeCompanyId}`;
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

const resolveCompanyIdentity = async (context = {}) => {
  const userId = toUserIdString(context.userId || context.id || context._id || context.sub || context.user);
  let username = toUsername(context.username);
  let companyId = toUserIdString(context.companyId || context.company?._id || context.company?.id);
  let companyName = String(context.companyName || context.company?.name || '').trim();
  let companySlug = String(context.companySlug || context.company?.slug || '').trim();
  let cloudinaryFolderRoot = String(context.cloudinaryFolderRoot || context.company?.cloudinaryFolderRoot || '').trim();

  if ((!companyId || !companyName) && userId) {
    const profile = await adminCredentialsService.getUserProfileByUserId(userId);
    username = username || String(profile?.username || '').trim();
    companyId = companyId || String(profile?.companyId || '').trim();
    companyName = companyName || String(profile?.companyName || '').trim();
    companySlug = companySlug || String(profile?.companySlug || '').trim();
    cloudinaryFolderRoot = cloudinaryFolderRoot || String(profile?.cloudinaryFolderRoot || '').trim();
  }

  if (!companyId) {
    throw buildMissingContextError(`Unable to resolve companyId for Cloudinary audio folder (userId=${userId || 'unknown'})`);
  }

  const root = cloudinaryFolderRoot || buildCompanyRoot({ companyName, companySlug, companyId });
  if (!root) {
    throw buildMissingContextError(`Unable to resolve company Cloudinary root for audio folder (companyId=${companyId})`);
  }

  return {
    userId,
    username,
    companyId,
    companyName,
    companySlug,
    root
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
  const identity = await resolveCompanyIdentity(context);
  const root = identity.root;
  const audioRoot = `${root}/audio`;
  const ivrAudioFolder = `${audioRoot}/ivr-audio`;
  const broadcastAudioFolder = `${audioRoot}/broadcast-audio`;
  const cacheKey = `${identity.companyId}:${root}`;

  if (!ensuredFolderCache.has(cacheKey)) {
    await createFolderIfMissing(root);
    await createFolderIfMissing(audioRoot);
    await createFolderIfMissing(ivrAudioFolder);
    await createFolderIfMissing(broadcastAudioFolder);
    ensuredFolderCache.add(cacheKey);
    logger.info(`Ensured Cloudinary company audio folders for ${identity.companyName || identity.companyId}`);
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
