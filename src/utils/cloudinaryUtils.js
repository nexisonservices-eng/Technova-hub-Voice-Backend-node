/**
 * Cloudinary Upload Service
 * Upload generated audio files to Cloudinary for public access
 */
import { v2 as cloudinary } from 'cloudinary';
import logger from './logger.js';

// Check if Cloudinary is properly configured
const isConfigured = !!(process.env.CLOUDINARY_CLOUD_NAME && 
                       process.env.CLOUDINARY_API_KEY && 
                       process.env.CLOUDINARY_API_SECRET);

if (!isConfigured) {
  logger.warn('Cloudinary not configured - audio uploads will be disabled');
  logger.warn('Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in .env');
}

// Initialize Cloudinary
if (isConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'audio broadcast';

function extractPublicIdFromCloudinaryUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/\/video\/upload\/(?:v\d+\/)?([^?]+?)(?:\.[a-zA-Z0-9]+)(?:\?|$)/);
  return match ? match[1] : null;
}

function stripAudioExtension(value) {
  if (!value || typeof value !== 'string') return value;
  return value.replace(/\.(mp3|wav|m4a|ogg)$/i, '');
}

function buildPublicIdVariants(publicIdOrUrl) {
  const raw = typeof publicIdOrUrl === 'string' ? publicIdOrUrl.trim() : '';
  if (!raw) return [];

  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();

  const extracted = extractPublicIdFromCloudinaryUrl(decoded);
  const baseCandidates = [raw, decoded, extracted].filter(Boolean);

  const variants = new Set();
  for (const candidate of baseCandidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    variants.add(trimmed);
    variants.add(stripAudioExtension(trimmed));
  }

  return [...variants].filter(Boolean);
}

/**
 * Upload audio buffer to Cloudinary
 */
export async function uploadToCloudinary(buffer, fileName, options = {}) {
  // Check if Cloudinary is configured
  if (!isConfigured) {
    const error = new Error('Cloudinary not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in .env');
    logger.error(`Cloudinary upload failed for ${fileName}:`, error.message);
    throw error;
  }

  try {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: CLOUDINARY_FOLDER,
          resource_type: 'video', // Use 'video' for audio files
          format: options.format || 'mp3',
          public_id: fileName.replace(/\.[^/.]+$/, ""), // Remove extension
          overwrite: true,
          invalidate: true
        },
        (error, result) => {
          if (error) {
            logger.error(`Cloudinary upload failed for ${fileName}:`, error);
            reject(error);
          } else {
            const secureUrl = result.secure_url;
            logger.info(`File uploaded to Cloudinary: ${fileName} -> ${secureUrl}`);
            
            resolve({
              url: secureUrl,
              key: result.public_id,
              bucket: 'cloudinary',
              publicId: result.public_id,
              format: result.format
            });
          }
        }
      );

      // Upload the buffer
      uploadStream.end(buffer);
    });
  } catch (error) {
    logger.error(`Cloudinary upload failed for ${fileName}:`, error);
    throw error;
  }
}

/**
 * Delete file from Cloudinary
 */
export async function deleteFromCloudinary(publicId) {
  if (!isConfigured) {
    logger.warn(`Cloudinary not configured - cannot delete ${publicId}`);
    return;
  }

  try {
    const variants = buildPublicIdVariants(publicId);
    if (variants.length === 0) {
      logger.warn(`No valid Cloudinary public_id found for deletion input: ${publicId}`);
      return;
    }

    let anyDeleted = false;

    for (const variant of variants) {
      const result = await cloudinary.uploader.destroy(variant, {
        resource_type: 'video', // Use 'video' for audio files
        type: 'upload',
        invalidate: true
      });

      if (result?.result === 'ok') {
        anyDeleted = true;
        logger.info(`File deleted from Cloudinary: ${variant}`);
        break;
      }

      logger.warn(`Cloudinary delete miss for ${variant}: ${result?.result || 'unknown result'}`);
    }

    if (!anyDeleted) {
      logger.warn(`Cloudinary delete did not remove asset for input: ${publicId}`);
    }
  } catch (error) {
    logger.error(`Cloudinary delete failed for ${publicId}:`, error);
    throw error;
  }
}

/**
 * Generate pre-signed URL (Cloudinary URLs are already public)
 */
export function getCloudinaryUrl(publicId, options = {}) {
  if (!isConfigured) {
    throw new Error('Cloudinary not configured');
  }

  return cloudinary.url(publicId, {
    resource_type: 'video',
    format: options.format || 'mp3',
    secure: true
  });
}

/**
 * Check if Cloudinary is properly configured
 */
export function isCloudinaryConfigured() {
  return isConfigured;
}

// 🗑️ Delete file from Cloudinary by public_id
const deleteFile = (publicId) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.destroy(publicId, {
      resource_type: 'video', // Use 'video' for audio files
    }, (error, result) => {
      if (error) {
        logger.error('Cloudinary delete error:', error);
        reject(error);
      } else {
        logger.info('Cloudinary delete success:', result);
        resolve(result);
      }
    });
  });
};

// Export all functions
export default {
  ...cloudinary,
  deleteFile
};
