import { Router } from 'express';
import { getActiveDraw, getCurrentDraw, getDrawHistory } from '../controllers/draw.controller';
import { getSettings } from '../controllers/admin.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();
const auth = requireAuth as any;

// Retrieve the active draw publicly (no auth)
router.get('/active', getActiveDraw);

// Retrieve the current day's draw (requires auth)
router.get('/current', auth, getCurrentDraw);

// Retrieve past draws
router.get('/history', auth, getDrawHistory);

// Retrieve game settings (multiplier, limits) for all players
router.get('/settings', auth, getSettings);

export default router;
