import { Router } from 'express';
import { getBalance, deposit, withdraw, getMyTransactions, getNetworks } from '../controllers/wallet.controller';
import { requireAuth } from '../middleware/auth';
import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

const depositLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de tentatives de dépôt. Attendez 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

const auth = requireAuth as any;

router.get('/balance', auth, getBalance);
router.post('/deposit', auth, depositLimiter as any, deposit);
router.post('/withdraw', auth, withdraw);
router.get('/transactions', auth, getMyTransactions);
router.get('/networks', auth, getNetworks);

export default router;
