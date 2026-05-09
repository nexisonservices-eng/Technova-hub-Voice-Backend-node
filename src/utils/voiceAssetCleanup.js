import logger from './logger.js';
import { deleteAssets } from './cloudinaryDeleteService.js';

const PUBLIC_ID_KEYS = new Set([
  'audioAssetId',
  'audio_asset_id',
  'audioPublicId',
  'audio_public_id',
  'cloudinaryPublicId',
  'cloudinary_public_id',
  'publicId',
  'public_id'
]);

const URL_KEYS = new Set([
  'audioUrl',
  'audio_url',
  'recordingUrl',
  'recording_url'
]);

const toPlainObject = (value) => {
  if (!value) return value;
  if (typeof value.toObject === 'function') return value.toObject();
  return value;
};

const addAsset = (assets, seen, type, value) => {
  if (typeof value !== 'string') return;

  const text = String(value || '').trim();
  if (!text) return;

  const key = `${type}:${text}`;
  if (seen.has(key)) return;
  seen.add(key);

  assets.push(type === 'url' ? { url: text, resourceType: 'video' } : { publicId: text, resourceType: 'video' });
};

const walkForAudioAssets = (value, assets, seen, visited) => {
  const plain = toPlainObject(value);
  if (!plain || typeof plain !== 'object') return;

  if (visited.has(plain)) return;
  visited.add(plain);

  if (Array.isArray(plain)) {
    plain.forEach((item) => walkForAudioAssets(item, assets, seen, visited));
    return;
  }

  Object.entries(plain).forEach(([key, child]) => {
    if (PUBLIC_ID_KEYS.has(key)) {
      addAsset(assets, seen, 'publicId', child);
    } else if (URL_KEYS.has(key)) {
      addAsset(assets, seen, 'url', child);
    }

    if (child && typeof child === 'object') {
      walkForAudioAssets(child, assets, seen, visited);
    }
  });
};

export const collectVoiceAudioAssets = (...sources) => {
  const assets = [];
  const seen = new Set();
  const visited = new WeakSet();

  sources.forEach((source) => walkForAudioAssets(source, assets, seen, visited));
  return assets;
};

export const deleteVoiceAudioAssets = async (sources = [], context = {}) => {
  const assets = collectVoiceAudioAssets(...sources);
  if (!assets.length) {
    return { attempted: 0, deleted: 0, skipped: 0, warnings: [], collected: 0 };
  }

  try {
    const result = await deleteAssets(assets);
    return {
      ...result,
      collected: assets.length
    };
  } catch (error) {
    logger.warn('Voice audio asset cleanup failed', {
      context,
      message: error.message
    });
    return {
      attempted: 0,
      deleted: 0,
      skipped: assets.length,
      warnings: [error.message],
      collected: assets.length
    };
  }
};
