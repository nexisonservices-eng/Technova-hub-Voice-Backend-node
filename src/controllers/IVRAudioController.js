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
                req.file.originalname,
                {
                    userId: String(req.user?.userId || req.user?._id || req.user?.id || ''),
                    username: req.user?.username || ''
                }
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
        const suppliedRequestId = String(req.get?.('x-request-id') || req.headers?.['x-request-id'] || '').trim();
        const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedRequestId)
            ? suppliedRequestId
            : crypto.randomUUID();
        res.set?.('X-Request-ID', requestId);
        const requestStartedAt = Date.now();
        logger.info('ivr_tts_preview_started', {
            requestId, method: 'POST', route: '/ivr/tts/preview'
        });
        try {
            const {
                text,
                voice,
                language = 'en-GB',
                workflowId = '',
                nodeId = ''
            } = req.body;

            if (!text) {
                return res.status(400).json({ success: false, error: 'Text is required' });
            }

            const result = await IVRAudioService.generateAndUploadTTS(
                text,
                voice,
                language,
                {
                    userId: String(req.user?.userId || req.user?._id || req.user?.id || ''),
                    username: req.user?.username || '',
                    workflowId: String(workflowId || ''),
                    nodeId: String(nodeId || ''),
                    requestId
                }
            );

            logger.info('ivr_tts_preview_succeeded', {
                requestId, method: 'POST', route: '/ivr/tts/preview',
                durationMs: Date.now() - requestStartedAt, status: 200
            });
            res.json({
                success: true,
                audioUrl: result.audioUrl,
                publicId: result.publicId,
                storage: result.storage
            });
        } catch (error) {
            const message = error?.message || 'TTS preview generation failed';
            const upstreamStatus = error?.response?.status || 0;
            const isConnectionFailure = [
                'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNABORTED'
            ].includes(error?.code) || error?.code === 'PYTHON_TTS_UNAVAILABLE';
            const statusCode = upstreamStatus || (isConnectionFailure ? 502 : 500);
            const responseContentType = String(error?.response?.headers?.['content-type'] || '').toLowerCase();
            const upstreamClassification = error?.upstreamClassification || (
                upstreamStatus
                    ? (responseContentType.includes('text/html') ? 'html_error_page' : 'upstream_http_error')
                    : isConnectionFailure ? 'connection_error' : 'internal_error'
            );
            let likelyUpstreamSource = 'unknown';
            try {
                if (new URL(error?.serviceUrl || '').hostname.endsWith('.onrender.com') && upstreamClassification === 'html_error_page') {
                    likelyUpstreamSource = 'render_proxy';
                }
            } catch { /* service URL is unavailable */ }
            logger.error('ivr_tts_preview_failed', {
                requestId, method: 'POST', route: '/ivr/tts/preview',
                durationMs: Date.now() - requestStartedAt, status: statusCode,
                upstreamStatus: upstreamStatus || null, upstreamUrl: error?.serviceUrl || null,
                errorCode: error?.code || null, failureCategory: upstreamClassification
            });
            res.status(statusCode).json({
                success: false,
                error: message,
                details: {
                    requestId,
                    statusCode,
                    upstreamStatus: upstreamStatus || null,
                    code: error?.code || '',
                    serviceUrl: error?.serviceUrl || '',
                    upstreamClassification,
                    likelyUpstreamSource
                }
            });
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
