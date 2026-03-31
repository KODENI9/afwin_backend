import { Response } from 'express';
import { db } from '../config/firebase';
import { AuthenticatedRequest } from '../middleware/auth';
import { Bet, Transaction, Draw } from '../types';
import { BetSchema } from '../types/schemas';

// Helper to get or create a profile lazily (Supports Transactions)
export const getProfile = async (userId: string, displayName?: string, referredByCode?: string, t?: FirebaseFirestore.Transaction, email?: string) => {
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
      email: email || '',
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

  // Sync email if missing or changed
  if (email && existingData?.email !== email) {
    updates.email = email;
    updatedExisting = true;
  }

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

  const { draw_id, entries, request_id } = result.data;
  const newTotalAmount = entries.reduce((sum, e) => sum + e.amount, 0);

  try {
    await db.runTransaction(async (t) => {
      // 1. IDEMPOTENCY CHECK (Safety First)
      const idRef = db.collection('idempotency_keys').doc(request_id);
      const idDoc = await t.get(idRef);
      if (idDoc.exists) {
        throw new Error('Cette requête a déjà été traitée. Double-clic détecté.');
      }

      // 2. TRANSACTIONAL READS (Draw, Profile, Existing Bets)
      const drawRef = db.collection('draws').doc(draw_id);
      const profileRef = db.collection('profiles').doc(userId);
      const existingBetsQuery = db.collection('bets')
        .where('user_id', '==', userId)
        .where('draw_id', '==', draw_id);

      const [drawDoc, profileDoc, existingBetsSnapshot] = await Promise.all([
        t.get(drawRef),
        t.get(profileRef),
        t.get(existingBetsQuery)
      ]);

      // 3. STATS & DATA VALIDATION
      if (!drawDoc.exists) throw new Error('Tirage non trouvé');
      const drawData = drawDoc.data() as Draw;
      
      // DOUBLE PROTECTION: Status + Time
      const now = new Date().getTime();
      const endTime = new Date(drawData.endTime).getTime();
      
      if (drawData.status !== 'OPEN') throw new Error('Les mises sont fermées pour ce tirage.');
      if (now >= endTime) {
        console.warn(`[BetRejection] User ${userId} attempted late bet for ${draw_id}. ServerNow: ${new Date(now).toISOString()}, EndTime: ${drawData.endTime}`);
        throw new Error('Le délai de mise pour ce tirage est expiré.');
      }

      if (!profileDoc.exists) throw new Error('Profil utilisateur introuvable');
      const profileData = profileDoc.data();
      const currentBalance = profileData?.balance || 0;

      const existingBets = existingBetsSnapshot.docs.map(d => d.data() as Bet);
      const existingTotalAmount = existingBets.reduce((sum, b) => sum + b.amount, 0);
      const existingNumbers = new Set(existingBets.map(b => b.number));

      // 4. BUSINESS LOGIC CHECKS
      if (currentBalance < newTotalAmount) {
        throw new Error(`Solde insuffisant. Requis: ${newTotalAmount} CFA, Disponible: ${currentBalance} CFA.`);
      }

      const MAX_TOTAL_PER_DRAW = 50000;
      if (existingTotalAmount + newTotalAmount > MAX_TOTAL_PER_DRAW) {
        throw new Error(
          `Limite de mise par tirage atteinte (${MAX_TOTAL_PER_DRAW} CFA). Déjà misé: ${existingTotalAmount} CFA.`
        );
      }

      for (const entry of entries) {
        if (existingNumbers.has(entry.number)) {
          throw new Error(`Chiffre ${entry.number} déjà misé pour ce tirage.`);
        }
      }

      // 5. ATOMIC WRITES (Starting here, no more reads!)
      const FieldValue = require('firebase-admin').firestore.FieldValue;

      // Deduct balance uniquely
      t.update(profileRef, {
        balance: FieldValue.increment(-newTotalAmount),
        updated_at: new Date().toISOString()
      });

      // Update draw totals (Atomic increment for nested fields too)
      const drawUpdates: any = {
        totalPool: FieldValue.increment(newTotalAmount),
        updated_at: new Date().toISOString()
      };
      
      for (const entry of entries) {
        drawUpdates[`totalsByNumber.${entry.number}`] = FieldValue.increment(entry.amount);
        
        // Create bet document
        const betRef = db.collection('bets').doc();
        t.set(betRef, {
          user_id: userId,
          draw_id,
          number: entry.number,
          amount: entry.amount,
          status: 'PENDING',
          payoutAmount: 0,
          createdAt: new Date().toISOString()
        } as Bet);
      }
      t.update(drawRef, drawUpdates);

      // Log transaction
      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        user_id: userId,
        draw_id,
        type: 'bet',
        amount: -newTotalAmount,
        provider: 'AF-WIN',
        reference: `BET-${draw_id.substring(0, 8)}-${request_id.substring(0, 6)}`,
        status: 'approved',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      } as Transaction);

      // Register request_id (idempotency key)
      t.set(idRef, { 
        user_id: userId, 
        created_at: new Date().toISOString() 
      });
    });

    // Traceability log (Post-Transaction)
    const { logAudit, AuditAction } = require('../services/audit.service');
    logAudit(AuditAction.BET_PLACED, { entries, request_id }, 'USER', userId, newTotalAmount, draw_id);

    res.status(200).json({ success: true, message: 'Paris enregistrés avec succès.' });
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
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;

  try {
    let query: any = db.collection('bets')
      .where('user_id', '==', userId);

    if (startDate) {
      query = query.where('createdAt', '>=', startDate);
    }
    if (endDate) {
      query = query.where('createdAt', '<=', endDate);
    }

    let snapshot;
    let nextCursor = null;
    let bets: Bet[] = [];

    try {
      let finalQuery = query.orderBy('createdAt', 'desc').limit(limit);
      
      if (lastDocId) {
        const lastDoc = await db.collection('bets').doc(lastDocId).get();
        if (lastDoc.exists) {
          finalQuery = finalQuery.startAfter(lastDoc);
        }
      }

      snapshot = await finalQuery.get();
      bets = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() as Bet }));
      nextCursor = snapshot.docs.length === limit ? snapshot.docs[snapshot.docs.length - 1]?.id : null;
    } catch (queryError: any) {
      if (queryError.message.includes('FAILED_PRECONDITION')) {
        console.warn('[getMyHistory] Index Missing Fallback: Fetching without OrderBy.');
        // Fallback: Fetch without ordering, then sort in memory
        snapshot = await query.limit(limit * 2).get(); // Fetch more to ensure we have enough after sorting
        bets = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() as Bet }));
        
        // Robust sort (supports ISO strings)
        bets.sort((a: Bet, b: Bet) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        
        // Apply limit after manual sort
        bets = bets.slice(0, limit);
        nextCursor = null; // Pagination is disabled in fallback mode
      } else {
        throw queryError;
      }
    }

    if (bets.length === 0) {
      return res.status(200).json({ history: [], nextCursor: null });
    }

    // Identify unique draw IDs
    const drawIds = [...new Set(bets.map((b: Bet) => b.draw_id))].filter(id => !!id);

    // Batch fetch draws (using FieldPath for robustness)
    const FieldPath = require('firebase-admin').firestore.FieldPath;
    const drawsMap: Record<string, Draw> = {};

    if (drawIds.length > 0) {
      try {
        const drawsSnapshot = await db.collection('draws')
          .where(FieldPath.documentId(), 'in', drawIds)
          .get();
        
        drawsSnapshot.docs.forEach((doc: any) => {
          drawsMap[doc.id] = doc.data() as Draw;
        });
      } catch (drawFetchErr: any) {
        console.error('[getMyHistory] Error fetching associated draws:', drawFetchErr.message);
        // We continue with empty drawsMap to allow bets to be seen anyway
      }
    }

    // Group bets by draw_id (maintaining order by createdAt)
    const groupedData: any[] = [];
    const drawOrder: string[] = [];

    bets.forEach((bet: Bet) => {
      if (!drawOrder.includes(bet.draw_id)) {
        drawOrder.push(bet.draw_id);
      }
    });

    drawOrder.forEach((drawId: string) => {
      const draw = drawsMap[drawId];
      // Fallback if draw metadata is missing
      const drawBets = bets.filter((b: Bet) => b.draw_id === drawId);
      const totalBetAmount = drawBets.reduce((sum: number, b: Bet) => sum + b.amount, 0);
      const totalWinAmount = drawBets.reduce((sum: number, b: Bet) => sum + (b.status === 'WON' ? (b.payoutAmount || 0) : 0), 0);

      groupedData.push({
        drawId,
        startTime: draw?.startTime || '?',
        endTime: draw?.endTime || '?',
        status: draw?.status || 'UNKNOWN',
        winningNumber: draw?.winningNumber,
        realMultiplier: draw?.realMultiplier,
        bets: drawBets.map((b: Bet) => ({
          number: b.number,
          amount: b.amount,
          status: b.status,
          payoutAmount: b.payoutAmount,
          createdAt: b.createdAt
        })),
        totalBetAmount,
        totalWinAmount,
        date: drawBets[0]?.createdAt 
      });
    });

    return res.status(200).json({ 
      history: groupedData, 
      nextCursor
    });

  } catch (error: any) {
    console.error('Fatal Error fetching bet history:', error);
    
    // Check if it's an index error
    if (error.message?.includes('FAILED_PRECONDITION')) {
      return res.status(400).json({ 
        error: 'Index required', 
        message: 'A composite index is required for this query. Please check your Firestore logs.' 
      });
    }

    res.status(500).json({ error: 'Failed to fetch bet history', message: error.message });
  }
};

export const getMyBets = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const query = db.collection('bets').where('user_id', '==', userId);
    
    try {
      const snapshot = await query.orderBy('createdAt', 'desc').limit(50).get();
      const bets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
      return res.status(200).json(bets);
    } catch (queryError: any) {
      const snapshot = await query.limit(50).get();
      const bets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
      
      // Tri en mémoire robuste (supporte ISO strings et Timestamps)
      const getMs = (val: any) => {
        if (!val) return 0;
        if (typeof val === 'string') return new Date(val).getTime();
        if (val.toDate) return val.toDate().getTime();
        return new Date(val).getTime();
      };
      bets.sort((a, b) => getMs(b.createdAt) - getMs(a.createdAt));
      
      return res.status(200).json(bets);
    }
  } catch (error: any) {
    console.error('Error fetching bets:', error);
    res.status(500).json({ error: 'Failed to fetch bets', message: error.message });
  }
};
