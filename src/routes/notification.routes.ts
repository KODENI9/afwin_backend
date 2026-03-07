import { Router } from 'express';
import type { RequestHandler } from 'express';
import { getMyNotifications, markAsRead } from '../controllers/notification.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth as unknown as RequestHandler, getMyNotifications as unknown as RequestHandler);
router.patch('/:notificationId/read', requireAuth as unknown as RequestHandler, markAsRead as unknown as RequestHandler);

export default router;
