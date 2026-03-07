import { Response } from 'express';
import { db } from '../config/firebase';
import { AuthenticatedRequest } from '../middleware/auth';
import { Bet, Draw, Transaction, Notification, UserProfile, Network } from '../types';
import { extractTxId } from '../utils/smsParser';

import { DrawService } from '../services/draw.service';
import { PayoutService } from '../services/payout.service';

export const resolveDraw = async (req: AuthenticatedRequest, res: Response) => {
  const { draw_id } = req.body;

  if (!draw_id) {
    return res.status(400).json({ error: 'ID du tirage obligatoire' });
  }

  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Ensure the person is an admin (redundant with middleware but safe)
    const profileRef = db.collection('profiles').doc(userId);
    const profileDoc = await profileRef.get();
    if (!profileDoc.exists || profileDoc.data()?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only access' });
    }

    // 1. Close first if not closed
    const drawRef = db.collection('draws').doc(draw_id);
    const drawDoc = await drawRef.get();
    if (drawDoc.data()?.status === 'OPEN') {
      await DrawService.closeDraw(draw_id);
    }

    // 2. Resolve (Deterministically find winner based on snapshot)
    await DrawService.resolveDraw(draw_id);

    // 3. Payout
    await PayoutService.distributePayouts(draw_id);

    res.status(200).json({ success: true, message: 'Draw resolved and payouts distributed.' });
  } catch (error: any) {
    console.error('Error resolving draw:', error);
    res.status(400).json({ error: error.message });
  }
};

export const getAllBetsForDraw = async (req: AuthenticatedRequest, res: Response) => {
  const { draw_id } = req.params;
  
  try {
    const betsRef = db.collection('bets');
    const snapshot = await betsRef.where('draw_id', '==', draw_id).get();
    
    const totals: Record<number, number> = {};
    for (let i = 1; i <= 9; i++) totals[i] = 0;
    
    let totalAmount = 0;
    const userIds = new Set();

    snapshot.docs.forEach(doc => {
      const data = doc.data() as Bet;
      userIds.add(data.user_id);

      // Multi-entry format: aggregate each entry's amount per number
      const entries = Array.isArray(data.entries) ? data.entries : [];
      for (const entry of entries) {
        if (typeof entry.number === 'number' && typeof entry.amount === 'number') {
          totals[entry.number] = (totals[entry.number] || 0) + entry.amount;
          totalAmount += entry.amount;
        }
      }
    });

    const betsByNumber = Object.entries(totals).map(([number, total]) => ({
      number: parseInt(number),
      total
    }));

    res.status(200).json({
      betsByNumber,
      totalAmount,
      bettorsCount: userIds.size
    });
  } catch (error) {
    console.error('Error fetching admin bets:', error);
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
};

export const getPendingTransactions = async (req: AuthenticatedRequest, res: Response) => {
  console.log('Fetching pending transactions...');
  try {
    const snapshot = await db.collection('transactions')
      .where('status', '==', 'pending')
      .get();
    
    console.log(`Found ${snapshot.size} pending transactions`);
    
    const transactions = await Promise.all(snapshot.docs.map(async doc => {
      const data = doc.data() as Transaction;
      let isPotentialDuplicate = false;
      
      const txId = extractTxId(data.sms_content || '');
      if (txId) {
        const dupCheck = await db.collection('transactions')
          .where('reference', '==', txId)
          .where('status', '==', 'approved')
          .limit(1)
          .get();
        if (!dupCheck.empty) {
          isPotentialDuplicate = true;
        }
      }

      // Fetch user profile info
      const profileDoc = await db.collection('profiles').doc(data.user_id).get();
      const profileData = profileDoc.exists ? profileDoc.data() : null;

      return { 
        id: doc.id, 
        ...data, 
        potential_duplicate: isPotentialDuplicate,
        extracted_tx_id: txId,
        user_name: profileData?.display_name || 'Inconnu',
        user_phone: profileData?.phone || 'Non renseigné'
      };
    }));
    
    // Sort in memory
    transactions.sort((a: any, b: any) => {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime(); // Newest first
    });

    res.status(200).json(transactions);
  } catch (error) {
    console.error('Error fetching pending transactions:', error);
    res.status(500).json({ error: 'Failed to fetch pending transactions' });
  }
};

export const reviewTransaction = async (req: AuthenticatedRequest, res: Response) => {
  const { transaction_id, action } = req.body; // action: 'approve' | 'reject'
  
  if (!transaction_id || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  const adminId = req.auth?.userId;
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await db.runTransaction(async (t) => {
      const transRef = db.collection('transactions').doc(transaction_id);
      const transDoc = await t.get(transRef);

      if (!transDoc.exists) throw new Error('Transaction not found');
      const transData = transDoc.data() as Transaction;
      if (transData.status !== 'pending') throw new Error('Transaction already reviewed');

      // Security: verify the person reviewing is an admin
      const adminProfileRef = db.collection('profiles').doc(adminId);
      const adminProfileDoc = await t.get(adminProfileRef);
      if (!adminProfileDoc.exists || adminProfileDoc.data()?.role !== 'admin') {
        throw new Error('Unauthorized: Admin role required');
      }

      const profileRef = db.collection('profiles').doc(transData.user_id);
      const profileDoc = await t.get(profileRef);
      const profileData = profileDoc.data();
      const userProfile = profileData as UserProfile;

      // Pre-fetch parrain profile if applicable (All reads must be before writes)
      let parrainDoc = null;
      if (action === 'approve' && transData.type === 'deposit') {
        const referredBy = profileData?.referred_by;
        if (referredBy && !profileData?.first_deposit_approved) {
          parrainDoc = await t.get(db.collection('profiles').doc(referredBy));
        }
      }

      if (action === 'approve') {
        if (transData.type === "deposit") {
          // ── F13: Anti-fraud: Check SMS TxID (Atomically) ───────────────────
          const txId = extractTxId(transData.sms_content || "");
          if (txId) {
            const duplicateCheck = await t.get(
              db.collection("transactions")
                .where("reference", "==", txId)
                .where("status", "==", "approved")
                .limit(1)
            );

            if (!duplicateCheck.empty) {
              throw new Error(`Fraude détectée: cet ID de transaction (${txId}) a déjà été utilisé !`);
            }
            // Save the ID in the transaction reference to prevent future use
            t.update(transRef, { reference: txId });
          }

          const currentBalance = profileData?.balance || 0;
          t.update(profileRef, { balance: currentBalance + transData.amount });

          // ── F12: Dynamic Referral Bonus (ONLY on first deposit) ─────────────
          console.log(`[Referral] Reviewing deposit for user: ${transData.user_id}. Referred by: ${userProfile.referred_by}, First deposit approved: ${userProfile.first_deposit_approved}`);
          
          if (userProfile.referred_by && !userProfile.first_deposit_approved && parrainDoc?.exists) {
            const parrainData = parrainDoc.data();
            console.log(`[Referral] Referral candidate found. Parrain: ${userProfile.referred_by}, Parrain Exists: ${parrainDoc.exists}`);
            
            // Determine percentage based on tiers
            let REFERRAL_PERCENTAGE = 0.05; // Default 5%
            if (transData.amount >= 20000) {
              REFERRAL_PERCENTAGE = 0.10; // 10%
            } else if (transData.amount >= 5000) {
              REFERRAL_PERCENTAGE = 0.07; // 7%
            }

            const bonusAmount = Math.floor(transData.amount * REFERRAL_PERCENTAGE);
            console.log(`[Referral] Calculated bonus: ${bonusAmount} (${REFERRAL_PERCENTAGE * 100}%) for deposit: ${transData.amount}`);
            
            if (bonusAmount > 0) {
              // Anti-fraud/Security Checks: No self-referral, parrain not blocked
              const isSelfReferral = userProfile.referred_by === transData.user_id;
              const isParrainBlocked = parrainData?.is_blocked === true;

              if (!isSelfReferral && !isParrainBlocked) {
                const parrainBalance = parrainData?.balance || 0;
                console.log(`[Referral] Success! Adding ${bonusAmount} to parrain ${userProfile.referred_by}. Old balance: ${parrainBalance}`);
                t.update(parrainDoc.ref, { balance: parrainBalance + bonusAmount });
                
                // Internal transaction for parrain
                const bonusRef = db.collection('transactions').doc();
                t.set(bonusRef, {
                  user_id: userProfile.referred_by,
                  type: 'referral_bonus',
                  amount: bonusAmount,
                  provider: 'System',
                  reference: `REF-BONUS-${transData.reference || transData.user_id.substring(0,6)}`,
                  status: 'approved',
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                });

                // Notify parrain
                const pNotifRef = db.collection('notifications').doc();
                t.set(pNotifRef, {
                  user_id: userProfile.referred_by,
                  title: 'Commission de parrainage ! 🎁',
                  message: `Félicitations ! Vous avez reçu un bonus de ${bonusAmount} CFA (${Math.round(REFERRAL_PERCENTAGE * 100)}%) suite au premier dépôt de votre filleul ${userProfile.display_name}.`,
                  type: 'win',
                  read: false,
                  created_at: new Date().toISOString()
                });
              } else {
                console.warn(`[Referral] Referral bonus skipped: Self-referral=${isSelfReferral}, ParrainBlocked=${isParrainBlocked}`);
              }
            }
          } else {
            console.log(`[Referral] Bonus criteria NOT met: hasReferrer=${!!userProfile.referred_by}, alreadyApproved=${!!userProfile.first_deposit_approved}, parrainExists=${!!parrainDoc?.exists}`);
          }
          
          // Mark first deposit as approved for the user
          if (!userProfile.first_deposit_approved) {
            t.update(profileRef, { first_deposit_approved: true });
          }
        }

        // For withdrawals, balance was already deducted, so we just mark as approved
        t.update(transRef, { status: "approved", updated_at: new Date().toISOString() });

        // Notify user of approval
        const notifRef = db.collection("notifications").doc();
        const notification: Notification = {
          user_id: transData.user_id,
          title: transData.type === "deposit" ? "Dépôt approuvé" : "Retrait approuvé",
          message: `Votre ${transData.type} de ${transData.amount} CFA a été approuvé.`,
          type: "info",
          read: false,
          created_at: new Date().toISOString(),
        };
        t.set(notifRef, notification);
      } else {
        if (transData.type === "withdrawal") {
          // Refund the blocked funds
          const currentBalance = profileData?.balance || 0;
          t.update(profileRef, { balance: currentBalance + transData.amount });
        }
        t.update(transRef, { status: "rejected", updated_at: new Date().toISOString() });

        // Notify user of rejection
        const notifRef = db.collection("notifications").doc();
        const notification: Notification = {
          user_id: transData.user_id,
          title: transData.type === "deposit" ? "Dépôt rejeté" : "Retrait rejeté",
          message: `Votre ${transData.type} de ${transData.amount} CFA a été rejeté.`,
          type: "system",
          read: false,
          created_at: new Date().toISOString(),
        };
        t.set(notifRef, notification);
      }
    });

    res.status(200).json({ success: true, message: `Transaction ${action}d successfully` });
  } catch (error: any) {
    console.error('Error reviewing transaction:', error);
    res.status(400).json({ error: error.message });
  }
};

export const checkAdminStatus = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const profileDoc = await db.collection('profiles').doc(userId).get();
    const isAdmin = profileDoc.exists && profileDoc.data()?.role === 'admin';
    res.status(200).json({ isAdmin });
  } catch (error) {
    console.error('Error checking admin status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Networks Management ──────────────────────────────────────────────────

export const getNetworksAdmin = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const snapshot = await db.collection('networks').orderBy('order', 'asc').get();
    const networks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(networks);
  } catch (error) {
    console.error('getNetworksAdmin error:', error);
    res.status(500).json({ error: 'Failed to fetch networks' });
  }
};

export const saveNetwork = async (req: AuthenticatedRequest, res: Response) => {
  const { id, name, ussd_template, destination_number, is_active, order } = req.body;
  
  if (!name || !ussd_template || !destination_number) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const networkData: Partial<Network> = {
      name,
      ussd_template,
      destination_number,
      is_active: is_active ?? true,
      order: order ?? 0
    };

    if (id) {
      await db.collection('networks').doc(id).update(networkData);
      res.status(200).json({ success: true, message: 'Network updated' });
    } else {
      await db.collection('networks').add(networkData);
      res.status(201).json({ success: true, message: 'Network created' });
    }
  } catch (error) {
    console.error('saveNetwork error:', error);
    res.status(500).json({ error: 'Failed to save network' });
  }
};

export const deleteNetwork = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'ID is required' });

  try {
    await db.collection('networks').doc(id as string).delete();
    res.status(200).json({ success: true, message: 'Network deleted' });
  } catch (error) {
    console.error('deleteNetwork error:', error);
    res.status(500).json({ error: 'Failed to delete network' });
  }
};

export const getSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const settingsRef = db.collection('settings').doc('game_config');
    const doc = await settingsRef.get();
    
    if (!doc.exists) {
      const defaultSettings = {
        multiplier: 5,
        min_bet: 100,
        max_bet: 50000,
        updated_at: new Date().toISOString()
      };
      await settingsRef.set(defaultSettings);
      return res.status(200).json(defaultSettings);
    }
    
    res.status(200).json(doc.data());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updateSettings = async (req: AuthenticatedRequest, res: Response) => {
  const { multiplier, min_bet, max_bet } = req.body;
  try {
    const settingsRef = db.collection('settings').doc('game_config');
    const updateData = {
      multiplier: Number(multiplier),
      min_bet: Number(min_bet),
      max_bet: Number(max_bet),
      updated_at: new Date().toISOString()
    };
    await settingsRef.set(updateData, { merge: true });
    res.status(200).json({ success: true, settings: updateData });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const listUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const snapshot = await db.collection('profiles').get();
    const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(users);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const toggleUserBlock = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id, is_blocked } = req.body;
  try {
    await db.collection('profiles').doc(user_id).update({ 
      is_blocked,
      updated_at: new Date().toISOString()
    });
    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updateUserBalance = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id, new_balance, reason } = req.body;
  try {
    await db.runTransaction(async (t) => {
      const profileRef = db.collection('profiles').doc(user_id);
      const profileDoc = await t.get(profileRef);
      if (!profileDoc.exists) throw new Error('User not found');

      t.update(profileRef, { 
        balance: Number(new_balance),
        updated_at: new Date().toISOString()
      });

      const adminId = req.auth?.userId;
      const logRef = db.collection('admin_logs').doc();
      t.set(logRef, {
        action: 'UPDATE_BALANCE',
        admin_id: adminId,
        target_user_id: user_id,
        old_balance: profileDoc.data()?.balance,
        new_balance: Number(new_balance),
        reason: reason || 'Manual adjustment',
        created_at: new Date().toISOString()
      });
    });
    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getGlobalStats = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const snapshots = await Promise.all([
      db.collection('transactions').where('status', '==', 'approved').get(),
      db.collection('bets').get(),
      db.collection('profiles').get()
    ]);

    const [transSnap, betsSnap, profilesSnap] = snapshots;

    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let totalBets = 0;
    let totalGains = 0;
    let totalReferralBonuses = 0;

    transSnap.docs.forEach(doc => {
      const data = doc.data();
      if (data.type === 'deposit') totalDeposits += data.amount;
      if (data.type === 'withdrawal') totalWithdrawals += data.amount;
      if (data.type === 'referral_bonus') totalReferralBonuses += data.amount;
    });

    betsSnap.docs.forEach(doc => {
      const data = doc.data();
      totalBets += data.amount;
      if (data.status === 'won') totalGains += data.payout || data.gain || 0;
    });

    // --- Time-based Stats (Daily - 30 days) ---
    const last30Days: Record<string, { bets: number, deposits: number, referrals: number }> = {};
    const now = new Date();
    for (let i = 0; i < 30; i++) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        const dateKey = d.toISOString().split('T')[0];
        if (dateKey) {
            last30Days[dateKey] = { bets: 0, deposits: 0, referrals: 0 };
        }
    }

    // --- Time-based Stats (Hourly - 24 hours) ---
    const last24Hours: Record<string, { bets: number, deposits: number }> = {};
    for (let i = 0; i < 24; i++) {
        const d = new Date(now.getTime() - (i * 60 * 60 * 1000));
        const hourKey = d.toISOString().substring(0, 13); // YYYY-MM-DDTHH
        last24Hours[hourKey] = { bets: 0, deposits: 0 };
    }

    betsSnap.docs.forEach(doc => {
        const data = doc.data();
        if (!data.created_at) return;
        
        const dateStr = data.created_at.split('T')[0];
        if (last30Days[dateStr]) {
            last30Days[dateStr].bets += data.amount;
        }

        const hourStr = data.created_at.substring(0, 13);
        if (last24Hours[hourStr]) {
            last24Hours[hourStr].bets += data.amount;
        }
    });

    transSnap.docs.forEach(doc => {
        const data = doc.data();
        if (!data.created_at) return;

        const dateStr = data.created_at.split('T')[0];
        const hourStr = data.created_at.substring(0, 13);

        if (data.type === 'deposit') {
            if (last30Days[dateStr]) last30Days[dateStr].deposits += data.amount;
            if (last24Hours[hourStr]) last24Hours[hourStr].deposits += data.amount;
        } else if (data.type === 'referral_bonus') {
            if (last30Days[dateStr]) last30Days[dateStr].referrals += data.amount;
        }
    });

    const dailyStats = Object.entries(last30Days)
      .map(([date, values]) => ({ date, ...values }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const hourlyStats = Object.entries(last24Hours)
      .map(([hour, values]) => ({ hour: hour.substring(11), ...values })) // Only HH
      .sort((a, b) => a.hour.localeCompare(b.hour));

    res.status(200).json({
      summary: {
        totalDeposits,
        totalWithdrawals,
        totalBets,
        totalGains,
        totalReferralBonuses,
        systemGains: totalBets - totalGains, // What system "earned" from bets
        netProfit: totalBets - totalGains - totalReferralBonuses, // Final profit
        usersCount: profilesSnap.size
      },
      dailyStats,
      hourlyStats
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getFailedSMS = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const snapshot = await db.collection('failed_sms').orderBy('created_at', 'desc').limit(50).get();
    const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(logs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
