import { Response } from 'express';
import { db } from '../config/firebase';
import { AuthenticatedRequest } from '../middleware/auth';
import { Bet, Draw, Transaction, Notification, UserProfile, Network, UserRole, GlobalNotification } from '../types';
import { extractTxId } from '../utils/smsParser';

import { DrawService } from '../services/draw.service';
import { PayoutService } from '../services/payout.service';
import { logAudit, AuditAction } from '../services/audit.service';
import { AnalyticsService } from '../services/analytics.service';
import { SmartDetectionService } from '../services/smartDetection.service';
import { ProfitEngineService } from '../services/profitEngine.service';

export const resolveDraw = async (req: AuthenticatedRequest, res: Response) => {
  const { draw_id } = req.body;

  if (!draw_id) {
    return res.status(400).json({ error: 'ID du tirage obligatoire' });
  }

  try {
    const adminId = req.auth?.userId;
    if (!adminId) return res.status(401).json({ error: 'Unauthorized' });

    // Ensure the person is an admin or super_admin
    const profileRef = db.collection('profiles').doc(adminId);
    const profileDoc = await profileRef.get();
    const role = profileDoc.data()?.role;
    if (!profileDoc.exists || (role !== 'admin' && role !== 'super_admin')) {
      return res.status(403).json({ error: 'Accès administrateur requis pour cette action.' });
    }

    // 1. Close first if not closed
    const drawRef = db.collection('draws').doc(draw_id);
    const drawDoc = await drawRef.get();
    if (drawDoc.data()?.status === 'OPEN') {
      await DrawService.closeDraw(draw_id);
    }

    // 3. Resolve (Deterministically find winner based on snapshot)
    await DrawService.resolveDraw(draw_id);

    // 4. Payout
    await PayoutService.distributePayouts(draw_id);

    // 5. Audit Log
    await logAudit(AuditAction.DRAW_RESOLVED, { draw_id, method: 'manual_super_admin' }, adminId, undefined, 0, draw_id);

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

      const num = Number(data.number);
      const amt = Number(data.amount);
      if (!isNaN(num) && num >= 1 && num <= 9 && !isNaN(amt)) {
        totals[num] = (totals[num] || 0) + amt;
        totalAmount += amt;
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
    
    // Sort in memory robustly
    const getMs = (val: any) => {
      if (!val) return 0;
      if (typeof val === 'string') {
        const d = new Date(val);
        return isNaN(d.getTime()) ? 0 : d.getTime();
      }
      if (val && typeof val.toDate === 'function') return val.toDate().getTime();
      const d = new Date(val);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    };

    transactions.sort((a: any, b: any) => getMs(b.created_at || b.createdAt) - getMs(a.created_at || a.createdAt));

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

        // Audit Log for Approval
        logAudit(
          transData.type === 'deposit' ? AuditAction.DEPOSIT : AuditAction.WITHDRAW,
          { transaction_id, status: 'approved', provider: transData.provider },
          adminId,
          transData.user_id,
          transData.amount,
          transData.draw_id
        );

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
        max_transfer_amount: 50000,
        updated_at: new Date().toISOString()
      };
      await settingsRef.set(defaultSettings);
      return res.status(200).json(defaultSettings);
    }
    
    res.status(200).json(doc.data());
  } catch (error: any) {
    console.error(`[AdminController] Error in getSettings:`, error.message);
    res.status(500).json({ error: error.message });
  }
};

export const updateSettings = async (req: AuthenticatedRequest, res: Response) => {
  const { multiplier, min_bet, max_bet, max_transfer_amount } = req.body;
  try {
    const settingsRef = db.collection('settings').doc('game_config');
    const updateData = {
      multiplier: Number(multiplier),
      min_bet: Number(min_bet),
      max_bet: Number(max_bet),
      max_transfer_amount: Number(max_transfer_amount || 50000),
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

  if (!reason || reason.trim().length < 4) {
    return res.status(400).json({ error: 'Un motif valide (min 4 caractères) est obligatoire pour tout ajustement manuel.' });
  }

  try {
    const adminId = req.auth?.userId;
    if (!adminId) return res.status(401).json({ error: 'Unauthorized' });

    await db.runTransaction(async (t) => {
      const profileRef = db.collection('profiles').doc(user_id);
      const profileDoc = await t.get(profileRef);
      if (!profileDoc.exists) throw new Error('Utilisateur introuvable');

      const oldBalance = profileDoc.data()?.balance || 0;
      const numNewBalance = Number(new_balance);

      t.update(profileRef, { 
        balance: numNewBalance,
        updated_at: new Date().toISOString()
      });

      // Internal Admin Log
      const logRef = db.collection('admin_logs').doc();
      t.set(logRef, {
        action: 'UPDATE_BALANCE',
        admin_id: adminId,
        target_user_id: user_id,
        old_balance: oldBalance,
        new_balance: numNewBalance,
        reason: reason.trim(),
        created_at: new Date().toISOString()
      });

      // Unified Audit Log
      logAudit(
        AuditAction.MANUAL_ADJUSTMENT,
        { reason: reason.trim(), old_balance: oldBalance, new_balance: numNewBalance },
        adminId,
        user_id,
        Math.abs(numNewBalance - oldBalance)
      );

      // Notify User
      const notifRef = db.collection('notifications').doc();
      t.set(notifRef, {
        user_id: user_id,
        title: 'Mise à jour de votre solde 💰',
        message: `Votre solde a été ajusté à ${numNewBalance.toLocaleString()} CFA par l'administration. Motif: ${reason}`,
        type: 'info',
        read: false,
        created_at: new Date().toISOString()
      });
    });
    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getUserTransactions = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.params;
  try {
    // Note: If this fails, it might need an index. Fallback to in-memory sort if needed.
    const snapshot = await db.collection('transactions')
      .where('user_id', '==', user_id)
      .limit(100)
      .get();
    
    const transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
    
    // Manual sort to avoid index requirements
    const getMs = (val: any) => {
      if (!val) return 0;
      if (typeof val === 'string') return new Date(val).getTime();
      if (val.toDate) return (val as any).toDate().getTime();
      return new Date(val).getTime();
    };

    transactions.sort((a, b) => getMs(b.created_at || b.createdAt) - getMs(a.created_at || a.createdAt));

    res.status(200).json(transactions);
  } catch (error: any) {
    console.error('getUserTransactions error:', error);
    res.status(500).json({ error: error.message });
  }
};
/**
 * ADMIN V2: Create a global notification proposal
 * Restricted to 3 PENDING max per admin.
 */
export const createGlobalNotification = async (req: AuthenticatedRequest, res: Response) => {
  const { title, message, type, target, user_id } = req.body;
  const adminId = req.auth?.userId;

  if (!adminId) return res.status(401).json({ error: 'Unauthorized' });
  if (!title || !message) return res.status(400).json({ error: 'Titre et message obligatoires' });

  try {
    const adminProfileRef = await db.collection('profiles').doc(adminId).get();
    const isSuperAdmin = adminProfileRef.exists && adminProfileRef.data()?.role === 'super_admin';

    if (!isSuperAdmin) {
      // 1. Anti-Spam Check: Max 3 PENDING per normal admin
      const pendingCount = await db.collection('global_notifications')
        .where('createdBy', '==', adminId)
        .where('status', '==', 'PENDING')
        .get();

      if (pendingCount.size >= 3) {
        return res.status(429).json({ 
          error: 'Limite atteinte', 
          message: 'Vous avez déjà 3 notifications en attente de validation. Veuillez attendre la validation du Super Admin.' 
        });
      }
    }

    const newNotif: Omit<GlobalNotification, 'id'> = {
      title,
      message,
      type: type || 'info',
      target: target || 'all',
      targetUserId: user_id || undefined,
      status: isSuperAdmin ? 'APPROVED' : 'PENDING',
      createdBy: adminId,
      createdAt: new Date().toISOString()
    };
    
    if (isSuperAdmin) {
      newNotif.validatedBy = adminId;
      newNotif.validatedAt = new Date().toISOString();
    }

    const docRef = await db.collection('global_notifications').add(newNotif);
    
    if (isSuperAdmin) {
       // DO FAN-OUT OR SPECIFIC SEND IMMEDIATELY
       let sentCount = 0;
       
       if (newNotif.target === 'user' && newNotif.targetUserId) {
         // Send to specific user
         const userNotifRef = db.collection('notifications').doc();
         await userNotifRef.set({
           user_id: newNotif.targetUserId,
           title: newNotif.title,
           message: newNotif.message,
           type: newNotif.type === 'warning' ? 'system' : newNotif.type === 'success' ? 'win' : 'info',
           read: false,
           created_at: new Date().toISOString()
         });
         sentCount = 1;
       } else {
         // Global Fan-out
         const usersSnapshot = await db.collection('profiles').get();
         const batchSize = 500;
         const batches = [];
         
         let currentBatch = db.batch();
         let count = 0;

         for (const userDoc of usersSnapshot.docs) {
           const userNotifRef = db.collection('notifications').doc();
           currentBatch.set(userNotifRef, {
             user_id: userDoc.id,
             title: newNotif.title,
             message: newNotif.message,
             type: newNotif.type === 'warning' ? 'system' : newNotif.type === 'success' ? 'win' : 'info',
             read: false,
             created_at: new Date().toISOString()
           });

           count++;
           if (count >= batchSize) {
             batches.push(currentBatch.commit());
             currentBatch = db.batch();
             count = 0;
           }
         }
         
         if (count > 0) batches.push(currentBatch.commit());
         await Promise.all(batches);
         sentCount = usersSnapshot.size;
       }

       // Audit Log
       await logAudit(AuditAction.UPDATE_PERMISSIONS, { 
         action: 'NOTIFICATION_CREATED_AND_APPROVED', 
         notificationId: docRef.id,
         target: newNotif.target || 'all'
       }, adminId);

       return res.status(201).json({ 
         success: true, 
         id: docRef.id, 
         message: `Notification créée et envoyée directement (Super Admin) à ${sentCount} utilisateur(s).` 
       });
    }

    // Normal Admin Audit Log (PENDING)
    await logAudit(AuditAction.UPDATE_PERMISSIONS, { action: 'NOTIFICATION_CREATED', notificationId: docRef.id }, adminId);

    res.status(201).json({ 
      success: true, 
      id: docRef.id, 
      message: 'Votre notification a été créée et est en attente de validation par un Super Admin.' 
    });
  } catch (error: any) {
    console.error('createGlobalNotification error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * SUPER_ADMIN: List all PENDING notifications
 */
export const getPendingNotifications = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const snapshot = await db.collection('global_notifications')
      .where('status', '==', 'PENDING')
      .get();

    const notifications = await Promise.all(snapshot.docs.map(async doc => {
      const data = doc.data();
      const creatorDoc = await db.collection('profiles').doc(data.createdBy).get();
      return { 
        id: doc.id, 
        ...data,
        creatorName: creatorDoc.exists ? creatorDoc.data()?.display_name : 'Admin inconnu'
      };
    }));

    res.status(200).json(notifications);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * SUPER_ADMIN: Approve and send notification
 */
export const approveNotification = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const superAdminId = req.auth?.userId;

  if (!superAdminId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const notifRef = db.collection('global_notifications').doc(id as string);
    const notifDoc = await notifRef.get();

    if (!notifDoc.exists) return res.status(404).json({ error: 'Notification introuvable' });
    const notifData = notifDoc.data() as GlobalNotification;

    if (notifData.status !== 'PENDING') {
      return res.status(400).json({ error: 'Cette notification a déjà été traitée.' });
    }

    // 1. Update status
    await notifRef.update({
      status: 'APPROVED',
      validatedBy: superAdminId as string,
      validatedAt: new Date().toISOString()
    });

    // 2. Perform Fan-out (Send to all users) OR send to specific user
    let sentCount = 0;
    
    if (notifData.target === 'user' && notifData.targetUserId) {
      // Send to specific user
      const userNotifRef = db.collection('notifications').doc();
      await userNotifRef.set({
        user_id: notifData.targetUserId,
        title: notifData.title,
        message: notifData.message,
        type: notifData.type === 'warning' ? 'system' : notifData.type === 'success' ? 'win' : 'info',
        read: false,
        created_at: new Date().toISOString()
      });
      sentCount = 1;
    } else {
      // Global Fan-out
      const usersSnapshot = await db.collection('profiles').get();
      const batchSize = 500;
      const batches = [];
      
      let currentBatch = db.batch();
      let count = 0;

      for (const userDoc of usersSnapshot.docs) {
        const userNotifRef = db.collection('notifications').doc();
        currentBatch.set(userNotifRef, {
          user_id: userDoc.id,
          title: notifData.title,
          message: notifData.message,
          type: notifData.type === 'warning' ? 'system' : notifData.type === 'success' ? 'win' : 'info',
          read: false,
          created_at: new Date().toISOString()
        });

        count++;
        if (count >= batchSize) {
          batches.push(currentBatch.commit());
          currentBatch = db.batch();
          count = 0;
        }
      }
      
      if (count > 0) batches.push(currentBatch.commit());
      await Promise.all(batches);
      sentCount = usersSnapshot.size;
    }

    // Audit Log
    await logAudit(AuditAction.UPDATE_PERMISSIONS, { 
      action: 'NOTIFICATION_APPROVED', 
      notificationId: id, 
      createdBy: notifData.createdBy,
      target: notifData.target || 'all'
    }, superAdminId);

    res.status(200).json({ success: true, message: `Notification approuvée et envoyée à ${sentCount} utilisateur(s).` });
  } catch (error: any) {
    console.error('approveNotification error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * SUPER_ADMIN: Reject notification
 */
export const rejectNotification = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;
  const superAdminId = req.auth?.userId;

  if (!superAdminId) return res.status(401).json({ error: 'Unauthorized' });
  if (!reason) return res.status(400).json({ error: 'Le motif du rejet est obligatoire.' });

  try {
    const notifRef = db.collection('global_notifications').doc(id as string);
    const notifDoc = await notifRef.get();

    if (!notifDoc.exists) return res.status(404).json({ error: 'Notification introuvable' });
    const notifData = notifDoc.data() as GlobalNotification;

    if (notifData.status !== 'PENDING') {
      return res.status(400).json({ error: 'Cette notification a déjà été traitée.' });
    }

    await notifRef.update({
      status: 'REJECTED',
      validatedBy: superAdminId as string,
      validatedAt: new Date().toISOString(),
      rejectionReason: reason
    });

    // Audit Log
    await logAudit(AuditAction.UPDATE_PERMISSIONS, { 
      action: 'NOTIFICATION_REJECTED', 
      notificationId: id, 
      reason 
    }, superAdminId);

    res.status(200).json({ success: true, message: 'Notification rejetée.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};


export const getDailyStats = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await AnalyticsService.getDailyHistory(30);
    res.status(200).json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getSmartPlayers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await SmartDetectionService.getSmartPlayers(20);
    res.status(200).json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getProfitSimulations = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await ProfitEngineService.simulateProfitLevels(30);
    res.status(200).json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getAuditLogs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const snapshot = await db.collection('audit_logs')
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    
    const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(logs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getGlobalStats = async (req: AuthenticatedRequest, res: Response) => {
  const adminId = req.auth?.userId;
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Check if SUPER_ADMIN for full financial access
    const adminDoc = await db.collection('profiles').doc(adminId as string).get();
    const isAdminSuper = adminDoc.exists && adminDoc.data()?.role === UserRole.SUPER_ADMIN;

    const kpis = await AnalyticsService.getGlobalKPIs();
    
    if (!isAdminSuper) {
      // Return only basics
      return res.status(200).json({
        summary: {
          totalUsers: kpis.totalUsers,
          totalBets: kpis.totalBets
          // ALL SENSITIVE DATA REMOVED
        }
      });
    }

    res.status(200).json({
      summary: kpis,
      dailyStats: [], 
      hourlyStats: []
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * ADMIN V2: Get basic stats only
 */
export const getBasicStats = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const kpis = await AnalyticsService.getGlobalKPIs();
    res.status(200).json({
      totalUsers: kpis.totalUsers,
      totalBets: kpis.totalBets
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

export const getAdmins = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // We fetch all profiles that have either 'admin' or 'super_admin' roles
    const snapshot = await db.collection('profiles')
      .where('role', 'in', ['admin', 'super_admin'])
      .get();
    
    const admins = snapshot.docs.map(doc => ({ 
      id: doc.id, 
      ...doc.data() 
    }));
    
    res.status(200).json(admins);
  } catch (error: any) {
    console.error('[AdminController] Error fetching admins:', error);
    res.status(500).json({ error: 'Failed to fetch admin list' });
  }
};

export const updateAdminPermissions = async (req: AuthenticatedRequest, res: Response) => {
  const { userId, permissions, role } = req.body;
  const adminId = req.auth?.userId;

  if (!userId) return res.status(400).json({ error: 'User ID is required' });
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const profileRef = db.collection('profiles').doc(userId);
    const profileDoc = await profileRef.get();

    if (!profileDoc.exists) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    const updateData: any = {
      updated_at: new Date().toISOString()
    };

    if (permissions !== undefined) updateData.permissions = permissions;
    if (role !== undefined) updateData.role = role;

    await profileRef.update(updateData);

    // Audit log
    await logAudit(
      AuditAction.UPDATE_PERMISSIONS,
      { 
        targetUser: userId, 
        newPermissions: permissions, 
        newRole: role,
        reason: 'Super Admin update' 
      },
      adminId
    );

    res.status(200).json({ success: true, message: 'Permissions updated successfully' });
  } catch (error: any) {
    console.error('[AdminController] Error updating permissions:', error);
    res.status(500).json({ error: error.message });
  }
};
