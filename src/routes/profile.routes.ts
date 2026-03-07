import { Router } from 'express';
import { getMyProfile, updateMyProfile, requestPinReset, verifyPinReset, getReferralStats } from '../controllers/profile.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();
const auth = requireAuth as any;

router.get('/me', auth, getMyProfile);
router.patch('/me', auth, updateMyProfile);
router.post('/request-pin-reset', auth, requestPinReset as any);
router.post('/verify-pin-reset', auth, verifyPinReset as any);
router.get('/referrals', auth, getReferralStats);

export default router;
