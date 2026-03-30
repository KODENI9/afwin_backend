import { Response } from 'express';
import { db } from '../config/firebase';
import { AuthenticatedRequest } from '../middleware/auth';
import { getProfile } from './bet.controller';
import { parseMobileMoneySMS } from '../utils/smsParser';
import { Transaction } from '../types';

export const getBalance = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Attempt to sync name from Clerk claims
    const fullName = req.auth?.claims?.name || req.auth?.claims?.fullName;
    const profile = await getProfile(userId, fullName);
    res.status(200).json({ balance: profile?.balance || 0 });
  } catch (error) {
    console.error('Error getting balance:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
};

export const deposit = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  const { smsContent } = req.body;
  
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!smsContent) return res.status(400).json({ error: 'SMS content is required' });

  try {
    console.log(`Received deposit request from user ${userId}`);
    const parsed = parseMobileMoneySMS(smsContent);
    if (!parsed) {
      console.warn(`Failed to parse SMS for user ${userId}:`, smsContent);
      // Log failed SMS for admin review
      await db.collection('failed_sms').add({
        user_id: userId,
        sms_content: smsContent,
        created_at: new Date().toISOString()
      });
      return res.status(400).json({ error: 'Format de SMS non reconnu. Assurez-vous de coller le message de confirmation complet.' });
    }

    console.log(`Parsed SMS: amount=${parsed.amount}, ref=${parsed.reference}, provider=${parsed.provider}`);

    // Check if reference already exists to prevent duplicate claims (Atomically)
    await db.runTransaction(async (t) => {
      const existingRef = await t.get(
        db.collection('transactions')
          .where('reference', '==', parsed.reference)
          .where('type', '==', 'deposit')
          .limit(1)
      );
      
      if (!existingRef.empty) {
        throw new Error('This transaction reference has already been submitted.');
      }

      const transaction: Transaction = {
        user_id: userId,
        type: 'deposit',
        amount: parsed.amount,
        provider: parsed.provider,
        reference: parsed.reference,
        sms_content: smsContent,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const transDocRef = db.collection('transactions').doc();
      t.set(transDocRef, transaction);
      console.log(`Transaction created with ID: ${transDocRef.id}`);
    });

    res.status(200).json({ 
      success: true, 
      message: 'Recharge request submitted. An admin will verify it shortly.',
      data: parsed
    });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Deposit request failed' });
  }
};

export const withdraw = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  const { amount, provider, account_details, pin } = req.body;
  
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  
  if (!pin) {
    return res.status(400).json({ error: 'Le code PIN est requis pour effectuer un retrait' });
  }

  const numAmount = parseFloat(String(amount));
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Montant invalide' });
  }
  
  try {
    const settingsRef = db.collection('settings').doc('game_config');
    const settingsDoc = await settingsRef.get();
    const minBet = settingsDoc.exists ? settingsDoc.data()?.min_bet || 100 : 100;

    if (numAmount < minBet) {
      return res.status(400).json({ error: `Le montant minimum de retrait est de ${minBet} CFA` });
    }

    const profileRef = db.collection('profiles').doc(userId);
    const profileDoc = await profileRef.get();
    
    if (!profileDoc.exists) {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    const profileData = profileDoc.data();
    if (!profileData?.pin_code) {
      return res.status(400).json({ error: 'Veuillez d\'abord configurer votre code PIN dans votre profil' });
    }

    if (profileData.pin_code !== String(pin)) {
      return res.status(403).json({ error: 'Code PIN incorrect' });
    }

    await db.runTransaction(async (t) => {
      const doc = await t.get(profileRef);
      if (!doc.exists) throw new Error('Profile not found');
      
      const currentBalance = doc.data()?.balance || 0;
      if (currentBalance < numAmount) throw new Error('Solde insuffisant');
      
      // Deduct balance immediately to "block" funds (Use numAmount for safety)
      t.update(profileRef, { balance: currentBalance - numAmount });

      // ── F20: Optional Withdrawal Number ─────────────────────────────
      // Use provided number or fallback to profile phone
      const finalWithdrawAccount = (account_details && account_details.trim()) 
        ? account_details.trim() 
        : (profileData?.phone || 'Not provided');

      // Create pending withdrawal transaction
      const transaction: Transaction = {
        user_id: userId,
        type: 'withdrawal',
        amount: numAmount,
        provider: provider || 'Mobile Money',
        account_details: finalWithdrawAccount,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      t.set(db.collection('transactions').doc(), transaction);
    });

    res.status(200).json({ success: true, message: 'Withdrawal request submitted for approval.' });
  } catch (error: any) {
    console.error('Withdrawal error:', error);
    res.status(400).json({ error: error.message || 'Withdrawal failed' });
  }
};

export const getMyTransactions = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const transactionsRef = db.collection('transactions');
    
    // Robust date retrieval for memory sorting
    const getMs = (val: any) => {
      if (!val) return 0;
      if (typeof val === 'string') {
        const d = new Date(val);
        return isNaN(d.getTime()) ? 0 : d.getTime();
      }
      if (val && typeof val.toDate === 'function') return val.toDate().getTime(); // Firestore Timestamp
      const d = new Date(val);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    };

    // Approach: ALWAYS use in-memory sorting for user transactions to avoid index issues
    // We fetch a bit more than needed to ensure we have recent ones
    try {
      const snapshot = await transactionsRef
        .where('user_id', '==', userId)
        .limit(100)
        .get();
        
      const transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
      
      // Robust in-memory sort (support ISO strings and Timestamps)
      transactions.sort((a: any, b: any) => getMs(b.created_at || b.createdAt) - getMs(a.created_at || a.createdAt));
      
      return res.status(200).json(transactions.slice(0, 30));
    } catch (queryError: any) {
      console.error(`[Firestore CRITICAL] getMyTransactions base query failed for user ${userId}:`, queryError.message);
      // Even if query fails, return empty array instead of 500 to keep UI stable
      return res.status(200).json([]);
    }
  } catch (error) {
    console.error('Fatal error in getMyTransactions controller:', error);
    res.status(200).json([]); // Always return something to the frontend
  }
};

export const getNetworks = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const networksRef = db.collection('networks');
    const snapshot = await networksRef.where('is_active', '==', true).get();
    
    const networks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
    
    // Sort in memory to avoid needing a composite index in Firestore
    networks.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    
    res.status(200).json(networks);
  } catch (error) {
    console.error('[Firestore] getNetworks error:', error);
    // Return empty array instead of 500 to keep UI stable
    res.status(200).json([]);
  }
};
export const searchUserByPseudo = async (req: AuthenticatedRequest, res: Response) => {
  const { pseudo } = req.query;
  if (!pseudo || typeof pseudo !== 'string') return res.status(400).json({ error: 'Pseudo requis' });

  const cleanPseudo = pseudo.toLowerCase().trim();

  try {
    const snapshot = await db.collection('profiles')
      .where('pseudo', '==', cleanPseudo)
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      return res.status(404).json({ error: 'Utilisateur introuvable avec ce pseudo' });
    }

    const userData = snapshot.docs[0]!.data();
    res.status(200).json({ 
      display_name: userData.display_name,
      user_id: userData.user_id,
      pseudo: userData.pseudo
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la recherche' });
  }
};

export const transferFunds = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  const { targetPseudo, amount, pin } = req.body;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  
  const numAmount = parseFloat(String(amount));
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Montant invalide' });
  }

  if (!pin) {
    return res.status(400).json({ error: 'Code PIN requis' });
  }

  try {
    const cleanTargetPseudo = targetPseudo?.toLowerCase().trim();
    if (!cleanTargetPseudo) return res.status(400).json({ error: 'Pseudo du destinataire requis' });

    const settingsDoc = await db.collection('settings').doc('game_config').get();
    const maxTransfer = settingsDoc.exists ? settingsDoc.data()?.max_transfer_amount || 50000 : 50000;

    if (numAmount > maxTransfer) {
      return res.status(400).json({ error: `Le montant maximum par transfert est de ${maxTransfer.toLocaleString()} CFA` });
    }

    // 1. Find Sender
    const senderRef = db.collection('profiles').doc(userId);
    const senderDoc = await senderRef.get();
    if (!senderDoc.exists) return res.status(404).json({ error: 'Profil expéditeur introuvable' });
    const senderData = senderDoc.data();

    // 2. Security Check (PIN)
    if (senderData?.pin_code !== String(pin)) {
      return res.status(403).json({ error: 'Code PIN incorrect' });
    }

    // 3. Find Receiver by Pseudo
    const receiverSnapshot = await db.collection('profiles')
      .where('pseudo', '==', cleanTargetPseudo)
      .limit(1)
      .get();
    
    if (receiverSnapshot.empty) {
      return res.status(404).json({ error: 'Destinataire introuvable avec ce pseudo' });
    }

    const receiverDoc = receiverSnapshot.docs[0]!;
    const receiverId = receiverDoc.id;
    const receiverRef = receiverDoc.ref;
    const receiverData = receiverDoc.data();

    if (receiverId === userId) {
      return res.status(400).json({ error: 'Vous ne pouvez pas vous envoyer de l\'argent à vous-même' });
    }

    // 4. Atomic Transaction
    await db.runTransaction(async (t) => {
      const sDoc = await t.get(senderRef);
      const rDoc = await t.get(receiverRef);

      const senderBalance = sDoc.data()?.balance || 0;
      if (senderBalance < numAmount) throw new Error('Solde insuffisant');

      const receiverBalance = rDoc.data()?.balance || 0;

      // Update Balances
      t.update(senderRef, { balance: senderBalance - numAmount, updated_at: new Date().toISOString() });
      t.update(receiverRef, { balance: receiverBalance + numAmount, updated_at: new Date().toISOString() });

      // Create Transactions
      const now = new Date().toISOString();
      const senderTx: Transaction = {
        user_id: userId,
        type: 'transfer_sent',
        amount: numAmount,
        provider: 'P2P Internal',
        account_details: `Vers: ${cleanTargetPseudo}`,
        status: 'approved',
        created_at: now,
        updated_at: now
      };

      const receiverTx: Transaction = {
        user_id: receiverId,
        type: 'transfer_received',
        amount: numAmount,
        provider: 'P2P Internal',
        account_details: `De: ${senderData?.pseudo || senderData?.display_name}`,
        status: 'approved',
        created_at: now,
        updated_at: now
      };

      t.set(db.collection('transactions').doc(), senderTx);
      t.set(db.collection('transactions').doc(), receiverTx);

      // Create Notification for Receiver
      const notification = {
        user_id: receiverId,
        title: '💰 Transfert Reçu',
        message: `Vous avez reçu ${numAmount.toLocaleString()} CFA de ${senderData?.display_name || 'un ami'}.`,
        type: 'info',
        read: false,
        created_at: now
      };
      t.set(db.collection('notifications').doc(), notification);
    });

    res.status(200).json({ success: true, message: 'Transfert effectué avec succès' });
  } catch (error: any) {
    console.error('Transfer error:', error);
    res.status(400).json({ error: error.message || 'Le transfert a échoué' });
  }
};
