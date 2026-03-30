import { Router } from 'express';
import { 
  resolveDraw, getAllBetsForDraw, checkAdminStatus, 
  getPendingTransactions, reviewTransaction,
  getNetworksAdmin, saveNetwork, deleteNetwork,
  getSettings, updateSettings, listUsers, toggleUserBlock, updateUserBalance,
  getGlobalStats, getFailedSMS, getDailyStats, getSmartPlayers, getProfitSimulations, getAuditLogs,
  getUserTransactions, sendAdminNotification
} from '../controllers/admin.controller';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { setMaintenanceMode, maintenanceMiddleware } from '../middleware/maintenance';
import { Request, Response } from 'express';
import { DrawService } from '../services/draw.service';
import { db } from '../config/firebase';

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
router.get('/users/:user_id/transactions', auth, admin, getUserTransactions);

// Notifications
router.post('/notifications/send', auth, admin, sendAdminNotification);

// Stats & Monitoring
router.get('/stats/global', auth, admin, getGlobalStats);
router.get('/stats/daily', auth, admin, getDailyStats);
router.get('/stats/simulations', auth, admin, getProfitSimulations);
router.get('/users/smart', auth, admin, getSmartPlayers);
router.get('/audit/logs', auth, admin, getAuditLogs);
router.get('/sms/failed', auth, admin, getFailedSMS);

// Emergency: Force resolve all CLOSED (un-locked) draws
router.post('/force-resolve-closed', auth, admin, async (req: Request, res: Response) => {
  try {
    const snap = await db.collection('draws').where('status', '==', 'CLOSED').get();
    const results: any[] = [];
    for (const doc of snap.docs) {
      if (doc.data().locked === true) {
        results.push({ id: doc.id, skipped: true, reason: 'already locked' });
        continue;
      }
      try {
        await DrawService.resolveDraw(doc.id);
        const updated = await db.collection('draws').doc(doc.id).get();
        results.push({ id: doc.id, resolved: true, winningNumber: updated.data()?.winningNumber });
      } catch (err: any) {
        results.push({ id: doc.id, resolved: false, error: err.message });
      }
    }
    res.json({ success: true, results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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
