import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { getProfile } from './bet.controller';
import { db } from '../config/firebase';
import { sendEmail } from '../utils/email';
import { clerkClient } from '@clerk/clerk-sdk-node';

export const getMyProfile = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const referredBy = req.query.referredBy as string;
    const profile = await getProfile(userId, undefined, referredBy);
    res.status(200).json(profile);
  } catch (error) {
    console.error('Error getting profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

export const updateMyProfile = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { display_name, phone, pin_code, pseudo } = req.body;
  const updates: any = { updated_at: new Date().toISOString() };

  if (pseudo && typeof pseudo === 'string') {
    const cleanPseudo = pseudo.toLowerCase().trim();
    if (cleanPseudo.length < 3) return res.status(400).json({ error: 'Le pseudo doit contenir au moins 3 caractères' });
    if (!/^[a-z0-9_]+$/.test(cleanPseudo)) return res.status(400).json({ error: 'Le pseudo ne peut contenir que des lettres, chiffres et underscores' });

    // Check uniqueness
    const existing = await db.collection('profiles').where('pseudo', '==', cleanPseudo).limit(1).get();
    if (!existing.empty && existing.docs[0]?.id !== userId) {
      return res.status(400).json({ error: 'Ce pseudo est déjà utilisé par un autre membre' });
    }
    updates.pseudo = cleanPseudo;
  }

  if (display_name && typeof display_name === 'string') {
    updates.display_name = display_name.trim().slice(0, 40);
  }
  
  if (phone !== undefined) {
    updates.phone = String(phone).trim().slice(0, 20);
  }

  if (pin_code !== undefined) {
    if (pin_code !== "" && !/^\d{4}$/.test(pin_code)) {
      return res.status(400).json({ error: 'Le code PIN doit contenir exactement 4 chiffres' });
    }
    updates.pin_code = pin_code;
  }

  try {
    await db.collection('profiles').doc(userId).set(
      updates,
      { merge: true }
    );
    res.status(200).json({ success: true, ...updates });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
};

export const requestPinReset = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  const claims = req.auth?.claims;
  // Try various common claim names for email
  let email = claims?.email || claims?.email_address || claims?.primary_email_address;

  if (!email && userId) {
    try {
      console.log(`[PinReset] Email missing from claims, fetching from Clerk SDK for user ${userId}...`);
      const user = await clerkClient.users.getUser(userId);
      email = user.emailAddresses.find(e => e.id === user.primaryEmailAddressId)?.emailAddress || user.emailAddresses[0]?.emailAddress;
      console.log(`[PinReset] Email found via SDK: ${email}`);
    } catch (err) {
      console.error(`[PinReset] Error fetching user from Clerk SDK:`, err);
    }
  }

  console.log(`[PinReset] Request for user ${userId}. Final Email: ${email}`);
  if (!email) {
    console.log(`[PinReset] Full claims:`, JSON.stringify(claims, null, 2));
  }

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!email) return res.status(400).json({ error: 'Email non trouvé dans vos informations de session' });

  try {
    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins

    await db.collection('pin_resets').doc(userId).set({
      code,
      expiresAt,
      created_at: new Date().toISOString()
    });

    const emailSent = await sendEmail(
      email,
      'Réinitialisation de votre code PIN',
      `Votre code de vérification est : ${code}`,
      `<div style="font-family: sans-serif; padding: 20px; color: #333;">
        <h2>Réinitialisation du code PIN</h2>
        <p>Vous avez demandé la réinitialisation de votre code PIN de sécurité.</p>
        <div style="background: #f4f4f4; padding: 15px; font-size: 24px; font-weight: bold; text-align: center; border-radius: 8px; letter-spacing: 5px;">
          ${code}
        </div>
        <p style="color: #666; font-size: 12px; margin-top: 20px;">Ce code expirera dans 15 minutes.</p>
      </div>`
    );

    if (emailSent) {
      res.status(200).json({ success: true, message: 'Code de vérification envoyé à ' + email });
    } else {
      res.status(500).json({ error: "Erreur lors de l'envoi de l'email" });
    }
  } catch (error) {
    console.error('Error requesting PIN reset:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const verifyPinReset = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  const { code, newPin } = req.body;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!code || !newPin) return res.status(400).json({ error: 'Paramètres manquants' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Code invalide' });
  if (!/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'Le nouveau PIN doit contenir 4 chiffres' });

  try {
    const resetRef = db.collection('pin_resets').doc(userId);
    const doc = await resetRef.get();

    if (!doc.exists) return res.status(400).json({ error: 'Aucune demande en cours' });

    const data = doc.data();
    if (data?.code !== code) return res.status(400).json({ error: 'Code incorrect' });
    if (new Date(data?.expiresAt) < new Date()) return res.status(400).json({ error: 'Code expiré' });

    // Success: Update PIN and delete reset request
    await db.collection('profiles').doc(userId).update({
      pin_code: newPin,
      updated_at: new Date().toISOString()
    });

    await resetRef.delete();

    res.status(200).json({ success: true, message: 'Code PIN mis à jour avec succès' });
  } catch (error) {
    console.error('Error verifying PIN reset:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getReferralStats = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const profileDoc = await db.collection('profiles').doc(userId).get();
    if (!profileDoc.exists) return res.status(404).json({ error: 'Profile not found' });

    const referralCode = profileDoc.data()?.referral_code;

    // Get referrals count
    const referralsSnapshot = await db.collection('profiles').where('referred_by', '==', userId).get();
    const referralsCount = referralsSnapshot.size;

    // Get total bonus earned from referral transactions
    try {
      const bonusSnapshot = await db.collection('transactions')
        .where('user_id', '==', userId)
        .where('type', '==', 'referral_bonus')
        .get();
      
      let totalBonus = 0;
      bonusSnapshot.docs.forEach(doc => {
        const data = doc.data();
        totalBonus += Number(data.amount) || 0;
      });

      res.status(200).json({
        referral_code: referralCode,
        referrals_count: referralsCount,
        total_bonus: totalBonus,
        referrals: referralsSnapshot.docs.map(doc => ({
          display_name: doc.data().display_name,
          created_at: doc.data().created_at
        }))
      });
    } catch (txError) {
      console.error('[Referral] Error fetching bonus transactions:', txError);
      // Fallback to 0 bonus instead of failing the whole profile request
      res.status(200).json({
        referral_code: referralCode,
        referrals_count: referralsCount,
        total_bonus: 0,
        referrals: referralsSnapshot.docs.map(doc => ({
          display_name: doc.data().display_name,
          created_at: doc.data().created_at
        }))
      });
    }
  } catch (error: any) {
    console.error('Fatal error in getReferralStats:', error);
    res.status(500).json({ error: error.message });
  }
};
