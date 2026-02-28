import fs from 'fs';
import path from 'path';
import cloudinary from "../utils/cloudinaryUtils.js";
import pythonTTSService from "./pythonTTSService.js";
import logger from '../utils/logger.js';

class IVRAudioService {
    constructor() {
        this.uploadDir = path.join(process.cwd(), 'uploads', 'audio');
        this.ensureUploadDir();
    }

    ensureUploadDir() {
        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }
    }

    /**
     * Upload audio to the preferred storage (Local or Cloudinary)
     * @param {Buffer|Stream} fileContent - The audio content
     * @param {string} publicId - Unique identifier for the asset
     * @param {string} language - Language code
     * @param {string} filename - Original filename (for local storage)
     * @returns {Promise<{audioUrl: string, publicId: string}>}
     */
    async uploadAudio(fileContent, publicId, language = 'en-GB', filename = null) {
        // Check if we should use Cloudinary (preferred for production)
        const useCloudinary = !!process.env.CLOUDINARY_CLOUD_NAME;

        if (useCloudinary) {
            return this.uploadToCloudinary(fileContent, publicId, language);
        } else {
            return this.uploadToLocal(fileContent, publicId, filename);
        }
    }

    /**
     * Upload to Cloudinary
     */
    async uploadToCloudinary(buffer, publicId, language) {
        return new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    resource_type: 'video',
                    public_id: publicId,
                    folder: 'ivr-audio',
                    format: 'mp3',
                    tags: ['ivr', language]
                },
                (err, result) => {
                    if (err) {
                        logger.error('Cloudinary upload failed:', err);
                        return reject(err);
                    }
                    resolve({
                        audioUrl: result.secure_url,
                        publicId: result.public_id,
                        storage: 'cloudinary'
                    });
                }
            );
            uploadStream.end(buffer);
        });
    }

    /**
     * Upload to Local Storage
     */
    async uploadToLocal(buffer, publicId, originalFilename) {
        const ext = originalFilename ? path.extname(originalFilename) : '.mp3';
        const filename = `${publicId}${ext}`;
        const filePath = path.join(this.uploadDir, filename);

        await fs.promises.writeFile(filePath, buffer);

        // Construct the URL (assumes /uploads is served statically)
        const audioUrl = `/uploads/audio/${filename}`;

        return {
            audioUrl,
            publicId: filename,
            storage: 'local'
        };
    }

    /**
     * Generate TTS and upload
     */
    async generateAndUploadTTS(text, voice, language) {
        logger.info(`Generating TTS for upload: text="${text.substring(0, 30)}...", voice=${voice}`);

        // Generate buffer from TTS service
        const buffer = await pythonTTSService.generateSpeech(text, language, voice);
        const publicId = `tts_${Date.now()}_${Math.round(Math.random() * 1000)}`;

        return this.uploadAudio(buffer, publicId, language);
    }

    /**
     * Delete audio from storage
     */
    async deleteAudio(publicId) {
        const useCloudinary = !!process.env.CLOUDINARY_CLOUD_NAME;

        if (useCloudinary) {
            return new Promise((resolve, reject) => {
                cloudinary.uploader.destroy(publicId, { resource_type: 'video' }, (err, result) => {
                    if (err) return reject(err);
                    // Keep delete API idempotent for repeated delete attempts.
                    resolve(result || { result: 'not_found' });
                });
            });
        }

        const filePath = path.join(this.uploadDir, publicId);
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            return { result: 'deleted' };
        }
        return { result: 'not_found' };
    }
}

export default new IVRAudioService();
