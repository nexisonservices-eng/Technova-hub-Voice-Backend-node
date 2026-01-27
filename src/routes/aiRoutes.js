// routes/aiRoutes.js
import express from 'express';
import AIBridgeService from '../services/aiBridgeService.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * 🌐 Test AI service
 */
router.post('/test', async (req, res) => {
    try {
        const { text } = req.body;
        const result = await AIBridgeService.testAI(text || 'Hello');
        res.json(result);
    } catch (error) {
        logger.error('AI test error:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
