import { Router } from 'express';
import { placeBet, getMyBets } from '../controllers/bet.controller';
import { requireAuth } from '../middleware/auth';
import { betGuard } from '../middleware/betGuard';

const router = Router();

router.post('/', requireAuth, betGuard, placeBet);
router.get('/my-bets', requireAuth, getMyBets);

export default router;
