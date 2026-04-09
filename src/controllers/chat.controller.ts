import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { ChatService, ALLOWED_REACTIONS } from '../services/chat.service';
import { db } from '../config/firebase';

// POST /api/chat/:drawId/messages
export const sendMessage = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { drawId } = req.params;
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Message vide' });

  try {
    const profileDoc = await db.collection('profiles').doc(userId).get();
    const profileData = profileDoc.data();
    const displayName = profileData?.display_name || profileData?.pseudo || 'Joueur';
    const role = profileData?.role || 'user';

    const messageId = await ChatService.sendMessage({
      drawId: drawId as string,
      userId,
      displayName,
      text,
      role,
    });

    res.status(201).json({ success: true, messageId });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

// GET /api/chat/:drawId/messages
export const getMessages = async (req: AuthenticatedRequest, res: Response) => {
  const { drawId } = req.params;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  try {
    const messages = await ChatService.getMessages(drawId as string, limit);
    res.status(200).json(messages);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

// POST /api/chat/:drawId/reactions
export const addReaction = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { drawId } = req.params;
  const { emoji } = req.body;
  try {
    await ChatService.addReaction(drawId as string, emoji);
    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

// GET /api/chat/:drawId/reactions
export const getReactions = async (req: AuthenticatedRequest, res: Response) => {
  const { drawId } = req.params;
  try {
    const reactions = await ChatService.getReactions(drawId as string);
    res.status(200).json(reactions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

// DELETE /api/chat/messages/:messageId (admin)
export const deleteMessage = async (req: AuthenticatedRequest, res: Response) => {
  const adminId = req.auth?.userId;
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' });
  const { messageId } = req.params;
  try {
    await ChatService.deleteMessage(messageId as string , adminId);
    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

// POST /api/chat/ban (admin)
export const banUser = async (req: AuthenticatedRequest, res: Response) => {
  const adminId = req.auth?.userId;
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' });
  const { user_id, action } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id obligatoire' });
  try {
    if (action === 'unban') {
      await ChatService.unbanUserFromChat(user_id);
      res.status(200).json({ success: true, message: 'Utilisateur débanni du chat.' });
    } else {
      await ChatService.banUserFromChat(user_id, adminId);
      res.status(200).json({ success: true, message: 'Utilisateur banni du chat.' });
    }
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

// GET /api/chat/reactions/allowed
export const getAllowedReactions = async (_req: AuthenticatedRequest, res: Response) => {
  res.status(200).json(ALLOWED_REACTIONS);
};