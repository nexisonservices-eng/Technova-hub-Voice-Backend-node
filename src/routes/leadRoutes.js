import express from 'express';
import leadController from '../controllers/leadController.js';
import { authenticate } from '../middleware/auth.js'; // Assuming auth middleware exists

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticate);

router.get('/', leadController.getLeads);
router.get('/export', leadController.exportLeads);
router.get('/:id', leadController.getLeadById);
router.put('/:id', leadController.updateLead);
router.delete('/:id', leadController.deleteLead);

export default router;
