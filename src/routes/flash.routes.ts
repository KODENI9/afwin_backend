import { Router } from 'express';
import { authorize } from '../middleware/authorize';
import { AdminPermission } from '../types';
import {
  createFlash,
  resolveFlashManual,
  listFlashes,
  saveFlashSchedule,
  getFlashSchedule,
  getActiveFlash,
} from '../controllers/flash.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

const auth = requireAuth as any;

// ── Routes publiques (user authentifié) ──────────────────────────────────────
router.get('/active', auth, getActiveFlash);

// ── Routes admin ─────────────────────────────────────────────────────────────
router.post('/create',   auth, authorize(AdminPermission.MANAGE_FLASH), createFlash);
router.post('/resolve',  auth, authorize(AdminPermission.MANAGE_FLASH), resolveFlashManual);
router.get('/list',      auth, authorize(AdminPermission.MANAGE_FLASH), listFlashes);
router.get('/schedule',  auth, authorize(AdminPermission.MANAGE_FLASH), getFlashSchedule);
router.post('/schedule', auth, authorize(AdminPermission.MANAGE_FLASH), saveFlashSchedule);

export default router;