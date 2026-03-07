import { Router } from 'express';
import { 
  resolveDraw, getAllBetsForDraw, checkAdminStatus, 
  getPendingTransactions, reviewTransaction,
  getNetworksAdmin, saveNetwork, deleteNetwork,
  getSettings, updateSettings, listUsers, toggleUserBlock, updateUserBalance,
  getGlobalStats, getFailedSMS
} from '../controllers/admin.controller';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { setMaintenanceMode, maintenanceMiddleware } from '../middleware/maintenance';
import { Request, Response } from 'express';

const router = Router();

const auth = requireAuth as any;
const admin = requireAdmin as any;

router.post('/resolve-draw', auth, admin, resolveDraw);
router.get('/draw-stats/:draw_id', auth, admin, getAllBetsForDraw);
router.get('/check', auth, checkAdminStatus);
router.get('/transactions/pending', auth, admin, getPendingTransactions);
router.post('/transactions/review', auth, admin, reviewTransaction);

// Network management
router.get('/networks', auth, admin, getNetworksAdmin);
router.post('/networks', auth, admin, saveNetwork);
router.delete('/networks/:id', auth, admin, deleteNetwork);

// Game settings
router.get('/settings', auth, admin, getSettings);
router.post('/settings', auth, admin, updateSettings);

// User management
router.get('/users', auth, admin, listUsers);
router.post('/users/toggle-block', auth, admin, toggleUserBlock);
router.post('/users/update-balance', auth, admin, updateUserBalance);

// Stats & Monitoring
router.get('/stats/global', auth, admin, getGlobalStats);
router.get('/sms/failed', auth, admin, getFailedSMS);

// Maintenance routes
router.post('/maintenance', auth, admin, setMaintenanceMode as any);
router.get('/maintenance', auth, admin, async (req: Request, res: Response) => {
  const { db } = await import('../config/firebase');
  try {
    const doc = await db.collection('settings').doc('maintenance').get();
    if (doc.exists) {
      res.json(doc.data());
    } else {
      res.json({ active: false, message: 'Le service est temporairement en maintenance.' });
    }
  } catch {
    res.status(500).json({ error: 'Failed to get maintenance status' });
  }
});

export default router;
