import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { authorize } from '../middleware/authorize';
import { AdminPermission } from '../types';
import {
  sendMessage,
  getMessages,
  addReaction,
  getReactions,
  deleteMessage,
  banUser,
  getAllowedReactions,
} from '../controllers/chat.controller';

const auth = requireAuth as any;

const router = Router();

// ── Routes publiques (user authentifié) ──────────────────────────────────────
router.get('/reactions/allowed',              auth, getAllowedReactions);
router.get('/:drawId/messages',               auth, getMessages);
router.post('/:drawId/messages',              auth, sendMessage);
router.post('/:drawId/reactions',             auth, addReaction);
router.get('/:drawId/reactions',              auth, getReactions);

// ── Routes admin ─────────────────────────────────────────────────────────────
router.delete('/messages/:messageId',         auth, authorize(AdminPermission.MANAGE_USERS), deleteMessage);
router.post('/ban',                           auth, authorize(AdminPermission.MANAGE_USERS), banUser);

export default router;