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
    const snapshot = await db.collection('transactions')
      .where('user_id', '==', userId)
      .limit(50)
      .get();
    
    const transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
    
    // Manual sort by date descending
    transactions.sort((a: any, b: any) => (b.created_at || '').localeCompare(a.created_at || ''));
    
    res.status(200).json(transactions.slice(0, 20));
  } catch (error) {
    console.error('Error getting transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
};

export const getNetworks = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const snapshot = await db.collection('networks')
      .where('is_active', '==', true)
      .get();
    
    const networks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
    
    // Sort in memory to avoid needing a composite index in Firestore
    networks.sort((a, b) => (a.order || 0) - (b.order || 0));
    
    res.status(200).json(networks);
  } catch (error) {
    console.error('getNetworks error:', error);
    res.status(500).json({ error: 'Failed to fetch networks' });
  }
};
