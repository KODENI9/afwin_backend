import { Router } from 'express';
import type { RequestHandler } from 'express';
import { getCurrentDraw, getDrawHistory } from '../controllers/draw.controller';
import { getSettings } from '../controllers/admin.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

const auth = requireAuth as any;

// Retrieve the current day's draw (or create if missing)
router.get('/current', auth, getCurrentDraw);

// Retrieve past draws
router.get('/history', auth, getDrawHistory);

// Retrieve game settings (multiplier, limits) for all players
router.get('/settings', auth, getSettings);

export default router;
