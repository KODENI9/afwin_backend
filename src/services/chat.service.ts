import { db } from '../config/firebase';
import * as admin from 'firebase-admin';

/**
 * ═══════════════════════════════════════════════════════
 *  AF-WIN — LIVE CHAT SERVICE
 * ═══════════════════════════════════════════════════════
 *
 * Collection : chat_messages
 * Structure  : { draw_id, user_id, display_name, text, created_at, deleted, role }
 *
 * Collection : chat_reactions
 * Structure  : { draw_id, emoji, count } — doc ID = `${draw_id}_${emoji}`
 */

const BANNED_WORDS = [
  'arnaque', 'escroquerie', 'voleur', 'fraudeur', 'triche',
  'fuck', 'merde', 'connard', 'putain', 'salope', 'idiot',
  'nigga', 'negro', 'pd', 'fdp', 'ntm',
];

export const filterMessage = (text: string): { clean: string; blocked: boolean } => {
  const lower = text.toLowerCase();
  for (const word of BANNED_WORDS) {
    if (lower.includes(word)) return { clean: '', blocked: true };
  }
  if (text.length > 300) return { clean: text.substring(0, 300), blocked: false };
  return { clean: text.trim(), blocked: false };
};

export const ALLOWED_REACTIONS = ['🔥', '🏆', '😱', '🎉', '💎', '🙏', '😤', '🤑'];

export class ChatService {

  static async sendMessage(params: {
    drawId: string;
    userId: string;
    displayName: string;
    text: string;
    role?: string;
  }): Promise<string> {
    const { drawId, userId, displayName, text, role = 'user' } = params;

    // Vérifier que le draw existe
    const drawDoc = await db.collection('draws').doc(drawId).get();
    if (!drawDoc.exists) throw new Error('Tirage introuvable');
    if (drawDoc.data()?.status === 'RESOLVED') {
      throw new Error('Le chat de ce tirage est fermé.');
    }

    // Vérifier ban
    const profileDoc = await db.collection('profiles').doc(userId).get();
    if (profileDoc.data()?.chat_banned === true) {
      throw new Error('Vous avez été banni du chat.');
    }

    // Modération automatique
    const { clean, blocked } = filterMessage(text);
    if (blocked) throw new Error('Message non autorisé — contenu inapproprié.');
    if (!clean) throw new Error('Message vide.');

    // Anti-spam : max 3 messages par minute
    const oneMinAgo = new Date(Date.now() - 60000).toISOString();
    const recentMsgs = await db.collection('chat_messages')
      .where('draw_id', '==', drawId)
      .where('user_id', '==', userId)
      .where('created_at', '>=', oneMinAgo)
      .get();

    if (recentMsgs.size >= 3) {
      throw new Error('Trop de messages. Attendez avant de réécrire.');
    }

    const docRef = await db.collection('chat_messages').add({
      draw_id: drawId,
      user_id: userId,
      display_name: displayName,
      text: clean,
      role,
      deleted: false,
      created_at: new Date().toISOString(),
    });

    return docRef.id;
  }

  static async getMessages(drawId: string, limit = 50): Promise<any[]> {
    const snapshot = await db.collection('chat_messages')
      .where('draw_id', '==', drawId)
      .where('deleted', '==', false)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).reverse();
  }

  static async deleteMessage(messageId: string, adminId: string): Promise<void> {
    const msgRef = db.collection('chat_messages').doc(messageId);
    const doc = await msgRef.get();
    if (!doc.exists) throw new Error('Message introuvable');
    await msgRef.update({
      deleted: true,
      deleted_by: adminId,
      deleted_at: new Date().toISOString(),
    });
  }

  static async banUserFromChat(targetUserId: string, adminId: string): Promise<void> {
    await db.collection('profiles').doc(targetUserId).update({
      chat_banned: true,
      chat_banned_by: adminId,
      chat_banned_at: new Date().toISOString(),
    });
  }

  static async unbanUserFromChat(targetUserId: string): Promise<void> {
    await db.collection('profiles').doc(targetUserId).update({
      chat_banned: false,
    });
  }

  static async addReaction(drawId: string, emoji: string): Promise<void> {
    if (!ALLOWED_REACTIONS.includes(emoji)) throw new Error('Réaction non autorisée.');
    const FieldValue = admin.firestore.FieldValue;
    const ref = db.collection('chat_reactions').doc(`${drawId}_${emoji}`);
    await ref.set({
      draw_id: drawId,
      emoji,
      count: FieldValue.increment(1),
      updated_at: new Date().toISOString(),
    }, { merge: true });
  }

  static async getReactions(drawId: string): Promise<any[]> {
    const snapshot = await db.collection('chat_reactions')
      .where('draw_id', '==', drawId)
      .get();
    return snapshot.docs.map(doc => doc.data());
  }
}