import { Router } from 'express';
import { getBalance, deposit, withdraw, getMyTransactions, getNetworks, transferFunds, searchUserByPseudo } from '../controllers/wallet.controller';
import { requireAuth } from '../middleware/auth';
import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

const transferLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives de transfert. Attendez 5 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

const auth = requireAuth as any;

router.get('/balance', auth, getBalance);
router.post('/deposit', auth, deposit as any, deposit);
router.post('/withdraw', auth, withdraw);
router.get('/transactions', auth, getMyTransactions);
router.get('/networks', auth, getNetworks);
router.get('/search-user', auth, searchUserByPseudo);
router.post('/transfer', auth, transferLimiter as any, transferFunds);

export default router;
