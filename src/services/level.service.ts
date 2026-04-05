import { db } from '../config/firebase';
import * as admin from 'firebase-admin';

/**
 * ═══════════════════════════════════════════════════════
 *  AF-WIN — SYSTÈME DE NIVEAUX & XP
 * ═══════════════════════════════════════════════════════
 *
 * Calcul XP :
 *   - 100 XP par tirage joué (peu importe le montant)
 *   - 1 XP par 1 000 CFA misés
 *
 * Grades :
 *   Bronze   →   0 XP
 *   Argent   →   500 XP
 *   Or       →   2 000 XP
 *   Platine  →   6 000 XP
 *   Diamond  →   15 000 XP
 */

export type Grade = 'bronze' | 'argent' | 'or' | 'platine' | 'diamond';

export interface LevelInfo {
  grade: Grade;
  label: string;
  emoji: string;
  minXP: number;
  nextXP: number | null; // null = niveau max
  color: string;
}

export const LEVELS: LevelInfo[] = [
  { grade: 'bronze',  label: 'Bronze',  emoji: '🥉', minXP: 0,      nextXP: 500,   color: '#CD7F32' },
  { grade: 'argent',  label: 'Argent',  emoji: '🥈', minXP: 500,    nextXP: 2000,  color: '#C0C0C0' },
  { grade: 'or',      label: 'Or',      emoji: '🥇', minXP: 2000,   nextXP: 6000,  color: '#FFD700' },
  { grade: 'platine', label: 'Platine', emoji: '💎', minXP: 6000,   nextXP: 15000, color: '#E5E4E2' },
  { grade: 'diamond', label: 'Diamond', emoji: '💠', minXP: 15000,  nextXP: null,  color: '#B9F2FF' },
];

/**
 * Retourne les infos du grade pour un montant de XP donné.
 */
export const getGradeFromXP = (xp: number): LevelInfo => {
  // Parcourir en ordre décroissant pour trouver le grade le plus élevé
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i]!.minXP) return LEVELS[i]!;
  }
  return LEVELS[0]!; // Bronze par défaut
};

/**
 * Calcule le XP gagné pour un pari.
 *   - 100 XP fixe par action de pari (peu importe le nombre de chiffres)
 *   - 1 XP par 1 000 CFA misés
 */
export const computeXPGain = (totalAmountBet: number): number => {
  const xpFromActivity = 100;
  const xpFromAmount = Math.floor(totalAmountBet / 1000);
  return xpFromActivity + xpFromAmount;
};

/**
 * Met à jour le XP et le grade d'un utilisateur après un pari.
 * Appelé APRÈS la transaction principale pour ne pas risquer de la bloquer.
 *
 * Retourne le nouveau grade si montée de niveau, null sinon.
 */
export const updateUserXP = async (
  userId: string,
  totalAmountBet: number
): Promise<{ newGrade: LevelInfo; leveledUp: boolean; oldGrade: LevelInfo; newXP: number } | null> => {
  const FieldValue = admin.firestore.FieldValue;
  const profileRef = db.collection('profiles').doc(userId);

  try {
    return await db.runTransaction(async (t) => {
      const profileDoc = await t.get(profileRef);
      if (!profileDoc.exists) return null;

      const data = profileDoc.data()!;
      const currentXP: number = data.xp || 0;
      const currentGrade = getGradeFromXP(currentXP);

      const xpGain = computeXPGain(totalAmountBet);
      const newXP = currentXP + xpGain;
      const newGrade = getGradeFromXP(newXP);

      const leveledUp = newGrade.grade !== currentGrade.grade;

      t.update(profileRef, {
        xp: newXP,
        grade: newGrade.grade,
        total_bets_count: FieldValue.increment(1),
        total_bets_amount: FieldValue.increment(totalAmountBet),
        updated_at: new Date().toISOString(),
        ...(leveledUp ? { leveled_up_at: new Date().toISOString() } : {}),
      });

      return { newGrade, leveledUp, oldGrade: currentGrade, newXP };
    });
  } catch (err) {
    // Non-bloquant : une erreur XP ne doit jamais affecter le pari
    console.error(`[XP] Failed to update XP for user ${userId}:`, err);
    return null;
  }
};

/**
 * Recalcule le XP et grade d'un utilisateur depuis zéro
 * (utile pour la migration des anciens utilisateurs).
 */
export const recalculateUserXP = async (userId: string): Promise<void> => {
  const betsSnapshot = await db.collection('bets')
    .where('user_id', '==', userId)
    .get();

  // Compter les tirages uniques joués
  const uniqueDraws = new Set(betsSnapshot.docs.map(d => d.data().draw_id));
  const totalDrawsPlayed = uniqueDraws.size;

  // Somme totale misée
  const totalAmountBet = betsSnapshot.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);

  // Recalcul XP
  const xp = (totalDrawsPlayed * 100) + Math.floor(totalAmountBet / 1000);
  const grade = getGradeFromXP(xp);

  await db.collection('profiles').doc(userId).update({
    xp,
    grade: grade.grade,
    total_bets_count: betsSnapshot.size,
    total_bets_amount: totalAmountBet,
    updated_at: new Date().toISOString(),
  });

  console.log(`[XP] Recalculated XP for ${userId}: ${xp} XP → ${grade.label}`);
};