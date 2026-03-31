import { Router } from 'express';
import { 
  resolveDraw, getAllBetsForDraw, checkAdminStatus, 
  getPendingTransactions, reviewTransaction,
  getNetworksAdmin, saveNetwork, deleteNetwork,
  getSettings, updateSettings, listUsers, toggleUserBlock, updateUserBalance,
  getGlobalStats, getFailedSMS, getDailyStats, getSmartPlayers, getProfitSimulations, getAuditLogs,
  getUserTransactions, sendAdminNotification, getAdmins, updateAdminPermissions
} from '../controllers/admin.controller';
import { requireAuth } from '../middleware/auth';
import { setMaintenanceMode } from '../middleware/maintenance';
import { Request, Response } from 'express';
import { DrawService } from '../services/draw.service';
import { db } from '../config/firebase';

import { authorize } from '../middleware/authorize';
import { AdminPermission } from '../types';

const router = Router();

const auth = requireAuth as any;

router.get('/check', auth, authorize(AdminPermission.VIEW_DASHBOARD), checkAdminStatus);

// Draw management
router.post('/resolve-draw', auth, authorize(AdminPermission.MANAGE_DRAWS), resolveDraw);
router.get('/draw-stats/:draw_id', auth, authorize(AdminPermission.VIEW_ADVANCED_STATS), getAllBetsForDraw);

// Transactions
router.get('/transactions/pending', auth, authorize(AdminPermission.VIEW_FINANCIALS), getPendingTransactions);
router.post('/transactions/review', auth, authorize(AdminPermission.VIEW_FINANCIALS), reviewTransaction);

// Network management
router.get('/networks', auth, authorize(AdminPermission.MANAGE_NETWORKS), getNetworksAdmin);
router.post('/networks', auth, authorize(AdminPermission.MANAGE_NETWORKS), saveNetwork);
router.delete('/networks/:id', auth, authorize(AdminPermission.MANAGE_NETWORKS), deleteNetwork);

// Game settings
router.get('/settings', auth, authorize(AdminPermission.MANAGE_SETTINGS), getSettings);
router.post('/settings', auth, authorize(AdminPermission.MANAGE_SETTINGS), updateSettings);

// User management
router.get('/users', auth, authorize(AdminPermission.VIEW_USERS), listUsers);
router.post('/users/toggle-block', auth, authorize(AdminPermission.MANAGE_USERS), toggleUserBlock);
router.post('/users/update-balance', auth, authorize(AdminPermission.MANAGE_USERS), updateUserBalance);
router.get('/users/:user_id/transactions', auth, authorize(AdminPermission.VIEW_FINANCIALS), getUserTransactions);

// Notifications
router.post('/notifications/send', auth, authorize(AdminPermission.SEND_GLOBAL_NOTIFICATION), sendAdminNotification);

// Stats & Monitoring
router.get('/stats/global', auth, authorize(AdminPermission.VIEW_PROFIT), getGlobalStats);
router.get('/stats/daily', auth, authorize(AdminPermission.VIEW_FINANCIALS), getDailyStats);
router.get('/stats/simulations', auth, authorize(AdminPermission.VIEW_PROFIT), getProfitSimulations);
router.get('/users/smart', auth, authorize(AdminPermission.VIEW_ADVANCED_STATS), getSmartPlayers);
router.get('/audit/logs', auth, authorize(AdminPermission.VIEW_AUDIT_LOGS), getAuditLogs);
router.get('/sms/failed', auth, authorize(AdminPermission.VIEW_ADVANCED_STATS), getFailedSMS);

// Super Admin routes (Management)
router.get('/admins', auth, authorize(AdminPermission.MANAGE_USERS), getAdmins);
router.patch('/permissions', auth, authorize(AdminPermission.MANAGE_USERS), updateAdminPermissions);

// Emergency: Force resolve all CLOSED (un-locked) draws
router.post('/force-resolve-closed', auth, authorize(AdminPermission.MANAGE_DRAWS), async (req: Request, res: Response) => {
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
router.post('/maintenance', auth, authorize(AdminPermission.MANAGE_SETTINGS), setMaintenanceMode as any);
router.get('/maintenance', auth, authorize(AdminPermission.MANAGE_SETTINGS), async (req: Request, res: Response) => {
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
