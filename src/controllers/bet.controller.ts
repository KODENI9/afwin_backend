import { Response } from 'express';
import { db } from '../config/firebase';
import { AuthenticatedRequest } from '../middleware/auth';
import { Bet, Transaction, Draw } from '../types';
import { BetSchema } from '../types/schemas';

// Helper to get or create a profile lazily (Supports Transactions)
export const getProfile = async (userId: string, displayName?: string, referredByCode?: string, t?: FirebaseFirestore.Transaction) => {
  const profileRef = db.collection('profiles').doc(userId);
  const doc = t ? await t.get(profileRef) : await profileRef.get();
  
  if (!doc.exists) {
    // Generate a unique referral code
    const referralCode = `AFW-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    
    let parrainId = null;
    if (referredByCode) {
      // Note: We don't use the transaction here for parrain lookup to keep it simple and avoid complex lock contention, 
      // as creating a profile is a one-time operation.
      const parrainSnapshot = await db.collection('profiles').where('referral_code', '==', referredByCode).limit(1).get();
      if (!parrainSnapshot.empty) {
        const parrainDoc = parrainSnapshot.docs[0];
        if (parrainDoc) parrainId = parrainDoc.id;
      }
    }

    const newProfile = {
      user_id: userId,
      display_name: displayName || `User ${userId.substring(0, 5)}`,
      balance: 0, 
      role: 'user',
      referral_code: referralCode,
      referred_by: parrainId,
      phone: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    if (t) {
      t.set(profileRef, newProfile);
    } else {
      await profileRef.set(newProfile);
    }
    return newProfile;
  }

  const existingData = doc.data();
  let updatedExisting = false;
  const updates: any = {};

  // Migration: If existing profile lacks a referral code, generate one now
  if (!existingData?.referral_code) {
    updates.referral_code = `AFW-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    updatedExisting = true;
  }

  // Support for retroactive referral: If account exists but has NO referrer, allow setting it now
  if (!existingData?.referred_by && referredByCode) {
    const parrainSnapshot = await db.collection('profiles').where('referral_code', '==', referredByCode).limit(1).get();
    if (!parrainSnapshot.empty) {
      const parrainDoc = parrainSnapshot.docs[0];
      if (parrainDoc && parrainDoc.id !== userId) {
        updates.referred_by = parrainDoc.id;
        updatedExisting = true;
        console.log(`[Retroactive Referral] Linked user ${userId} to parrain ${parrainDoc.id}`);
      }
    }
  }

  if (updatedExisting) {
    if (t) {
      t.update(profileRef, updates);
    } else {
      await profileRef.update(updates);
    }
    return { ...existingData, ...updates };
  }

  return existingData;
};

export const placeBet = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const result = BetSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.issues[0]!.message });
  }

  const { draw_id, entries } = result.data;
  // Total amount = sum of all entry amounts
  const totalAmount = entries.reduce((sum, e) => sum + e.amount, 0);

  try {
    await db.runTransaction(async (t) => {
      // 1. Check if user already bet in this draw (1 bet-doc per draw)
      const existingBet = await t.get(
        db.collection('bets')
          .where('user_id', '==', userId)
          .where('draw_id', '==', draw_id)
          .limit(1)
      );

      if (!existingBet.empty) {
        throw new Error("Vous avez déjà parié pour ce tirage.");
      }

      // 2. Check draw status inside transaction
      const drawRef = db.collection('draws').doc(draw_id);
      const drawDoc = await t.get(drawRef);
      if (!drawDoc.exists) throw new Error('Tirage non trouvé');

      const drawData = drawDoc.data() as Draw;
      if (drawData.status !== 'OPEN') throw new Error('Les mises sont fermées.');

      // 3. Economic protection: max 45% of pool on a single number (only if pool > 5000)
      const MAX_PERCENT = 0.45;
      const currentTotalsByNumber = (drawData as any).totalsByNumber || {};
      const currentPool = drawData.totalPool || 0;

      if (currentPool > 5000) {
        for (const entry of entries) {
          const currentForNumber = currentTotalsByNumber[entry.number] || 0;
          if ((currentForNumber + entry.amount) / (currentPool + totalAmount) > MAX_PERCENT) {
            throw new Error(
              `Le chiffre ${entry.number} a atteint sa limite de mises. Choisissez un autre chiffre.`
            );
          }
        }
      }

      // 4. Check profile & balance (Critical: Use transaction t)
      const profile = await getProfile(
        userId,
        req.auth?.claims?.name as string || req.auth?.claims?.fullName as string,
        undefined,
        t
      );
      const balance = profile?.balance || 0;
      const profileRef = db.collection('profiles').doc(userId);

      if (balance < totalAmount) throw new Error('Solde insuffisant');

      // 5. Deduct total amount from balance
      t.update(profileRef, {
        balance: balance - totalAmount,
        updated_at: new Date().toISOString()
      });

      // 6. Create individual Bet documents for each entry
      for (const entry of entries) {
        const newBetRef = db.collection('bets').doc();
        const newBet: Bet = {
          user_id: userId,
          draw_id,
          number: entry.number,
          amount: entry.amount,
          status: 'PENDING',
          payoutAmount: 0,
          createdAt: new Date().toISOString(),
        };
        t.set(newBetRef, newBet);
      }

      // 7. Update draw pool totals per entry number
      const updatedTotalsByNumber = { ...currentTotalsByNumber };
      for (const entry of entries) {
        updatedTotalsByNumber[entry.number] = (updatedTotalsByNumber[entry.number] || 0) + entry.amount;
      }
      t.update(drawRef, {
        totalPool: currentPool + totalAmount,
        totalsByNumber: updatedTotalsByNumber,
        updated_at: new Date().toISOString()
      });

      // 8. Log a single transaction for the total bet amount
      const txRef = db.collection('transactions').doc();
      const transaction: Transaction = {
        user_id: userId,
        draw_id,
        type: 'bet',
        amount: -totalAmount,
        provider: 'System',
        reference: `BET-${draw_id.substring(0, 8)}-${userId.substring(0, 8)}`,
        status: 'approved',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      t.set(txRef, transaction);
    });

    res.status(200).json({ success: true, message: 'Pari enregistré avec succès.' });
  } catch (error: any) {
    console.error('Error placing bet:', error);
    res.status(400).json({ error: error.message });
  }
};

export const getMyHistory = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const limit = parseInt(req.query.limit as string) || 20;
  const lastDocId = req.query.lastDocId as string;

  try {
    let query = db.collection('bets')
      .where('user_id', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(limit);

    if (lastDocId) {
      const lastDoc = await db.collection('bets').doc(lastDocId).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
    }

    const snapshot = await query.get();
    const bets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
    
    const nextCursor = snapshot.docs.length === limit 
      ? snapshot.docs[snapshot.docs.length - 1]?.id 
      : null;

    res.status(200).json({ bets, nextCursor });
  } catch (error) {
    console.error('Error fetching bet history:', error);
    res.status(500).json({ error: 'Failed to fetch bet history' });
  }
};

// Deprecated: getMyBets (keeping for backward compatibility but using the new structure)
export const getMyBets = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const snapshot = await db.collection('bets')
      .where('user_id', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
      
    const bets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
    res.status(200).json(bets);
  } catch (error) {
    console.error('Error fetching bets:', error);
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
};
