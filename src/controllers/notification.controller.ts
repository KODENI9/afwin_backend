import { Response } from 'express';
import { db } from '../config/firebase';
import { AuthenticatedRequest } from '../middleware/auth';

export const getMyNotifications = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const snapshot = await db.collection('notifications')
      .where('user_id', '==', userId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .get();
    
    const notifications = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
};

export const markAsRead = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  const { notificationId } = req.params;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!notificationId) return res.status(400).json({ error: 'Notification ID is required' });

  try {
    const id = notificationId as string;
    const notifRef = db.collection('notifications').doc(id);
    const doc = await notifRef.get();

    if (!doc.exists) return res.status(404).json({ error: 'Notification not found' });
    if (doc.data()?.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    await notifRef.update({ read: true });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
};
