import logger from '../utils/logger.js';
import IVRAudioService from "../services/IVRAudioService.js";
import crypto from 'crypto';

class IVRAudioController {
    sanitizePublicIdSegment(value, fallback = 'unknown') {
        const raw = typeof value === 'string' ? value.trim() : '';
        if (!raw) return fallback;
        const sanitized = raw
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return sanitized || fallback;
    }

    extractCloudinaryPublicIdFromUrl(audioUrl) {
        if (!audioUrl || typeof audioUrl !== 'string') return null;
        const match = audioUrl.match(/\/video\/upload\/(?:v\d+\/)?([^?]+?)(?:\.[a-zA-Z0-9]+)(?:\?|$)/);
        return match ? match[1] : null;
    }

    normalizeCloudinaryAssetId(candidate) {
        if (!candidate || typeof candidate !== 'string') return null;
        const trimmed = candidate.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            return this.extractCloudinaryPublicIdFromUrl(trimmed);
        }
        return trimmed;
    }

    async executeDelete(publicIdRaw, res) {
        const normalizedPublicId = this.normalizeCloudinaryAssetId(publicIdRaw);
        if (!normalizedPublicId) {
            return res.status(400).json({ success: false, error: 'publicId is required' });
        }

        const result = await IVRAudioService.deleteAudio(normalizedPublicId);
        const deleteResult = result?.result || 'unknown';
        const success = deleteResult === 'ok' || deleteResult === 'deleted' || deleteResult === 'not found' || deleteResult === 'not_found';

        return res.status(success ? 200 : 500).json({
            success,
            publicId: normalizedPublicId,
            result: deleteResult
        });
    }

    /**
     * Handle audio file upload
     */
    async upload(req, res) {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: 'No audio file provided' });
            }

            const {
                language = 'en-GB',
                workflowId = '',
                nodeId = '',
                existingAudioAssetId = ''
            } = req.body;
            const uniqueSuffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const publicId = (workflowId || nodeId)
                ? `workflows/${this.sanitizePublicIdSegment(workflowId, 'workflow')}/nodes/${this.sanitizePublicIdSegment(nodeId, 'node')}/${uniqueSuffix}`
                : `custom/${uniqueSuffix}`;

            logger.info(`📥 Audio upload requested: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB), language: ${language}`);

            const result = await IVRAudioService.uploadAudio(
                req.file.buffer || req.file.path, // handle memory or disk storage
                publicId,
                language,
                req.file.originalname
            );

            const existingAssetId = this.normalizeCloudinaryAssetId(existingAudioAssetId);
            let replacedPublicId = null;
            if (existingAssetId && existingAssetId !== result.publicId) {
                try {
                    await IVRAudioService.deleteAudio(existingAssetId);
                    replacedPublicId = existingAssetId;
                } catch (deleteError) {
                    logger.warn(`Failed to delete replaced node audio ${existingAssetId}: ${deleteError.message}`);
                }
            }

            res.json({
                success: true,
                audioUrl: result.audioUrl,
                publicId: result.publicId,
                storage: result.storage,
                replacedPublicId
            });
        } catch (error) {
            logger.error('Audio upload failed:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    /**
     * Handle TTS preview generation
     */
    async ttsPreview(req, res) {
        try {
            const { text, voice, language = 'en-GB' } = req.body;

            if (!text) {
                return res.status(400).json({ success: false, error: 'Text is required' });
            }

            logger.info(`🔊 TTS Preview requested: "${text.substring(0, 30)}...", voice: ${voice}`);

            const result = await IVRAudioService.generateAndUploadTTS(text, voice, language);

            res.json({
                success: true,
                audioUrl: result.audioUrl,
                publicId: result.publicId,
                storage: result.storage
            });
        } catch (error) {
            logger.error('TTS preview generation failed:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    /**
     * Delete audio file
     */
    async delete(req, res) {
        try {
            const publicId = decodeURIComponent(req.params.publicId);
            return await this.executeDelete(publicId, res);
        } catch (error) {
            logger.error('Audio deletion failed:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    /**
     * Delete audio file by publicId from request body
     */
    async deleteByPublicId(req, res) {
        try {
            const publicId = req.body?.publicId;
            return await this.executeDelete(publicId, res);
        } catch (error) {
            logger.error('Audio deletion by publicId failed:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
}

export default new IVRAudioController();
