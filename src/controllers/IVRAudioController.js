import logger from '../utils/logger.js';
import IVRAudioService from "../services/IVRAudioService.js";

class IVRAudioController {
    /**
     * Handle audio file upload
     */
    async upload(req, res) {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: 'No audio file provided' });
            }

            const { language = 'en-GB' } = req.body;
            const publicId = `ivr_custom_${Date.now()}`;

            logger.info(`📥 Audio upload requested: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB), language: ${language}`);

            const result = await IVRAudioService.uploadAudio(
                req.file.buffer || req.file.path, // handle memory or disk storage
                publicId,
                language,
                req.file.originalname
            );

            res.json({
                success: true,
                audioUrl: result.audioUrl,
                publicId: result.publicId,
                storage: result.storage
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
            console.log('Deleting:', publicId);

            await IVRAudioService.deleteAudio(publicId);

            res.json({
                success: true,
                message: 'Audio deleted successfully'
            });
        } catch (error) {
            logger.error('Audio deletion failed:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
}

export default new IVRAudioController();
