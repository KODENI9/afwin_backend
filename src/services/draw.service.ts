import { db } from '../config/firebase';
import { Draw, Bet } from '../types';
import { AuditAction, logAudit } from './audit.service';
import crypto from 'crypto';

export class DrawService {

  /**
   * Closes the draw for betting. Takes a snapshot of all bets.
   * Atomically transitions status from OPEN to CLOSED.
   */
  static async closeDraw(drawId: string): Promise<void> {
    const drawRef = db.collection('draws').doc(drawId);
    let auditData: any = null;
 
    // --- PHASE 1: LOCKING (Atomic Transition) ---
    await db.runTransaction(async (t) => {
      const drawDoc = await t.get(drawRef);
      if (!drawDoc.exists) throw new Error('Draw not found');
      const drawData = drawDoc.data() as Draw;
 
      if (drawData.status !== 'OPEN') {
        throw new Error(`Draw ${drawId} is not OPEN (current status: ${drawData.status})`);
      }
 
      t.update(drawRef, {
        status: 'CLOSED',
        closedAt: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    });
 
    console.log(`[Draw] Phase 1 Complete: Draw ${drawId} is now LOCKED (CLOSED).`);
 
    // --- PHASE 2: SNAPSHOTTING ---
    // FIX CRITIQUE : la query des bets est faite ICI, HORS transaction.
    // Firestore n'autorise que des DocumentReference.get() dans une transaction,
    // pas des queries .where(). Une query dans une transaction retourne silencieusement
    // un snapshot vide ou partiel → snapshotTotals faux → mauvais gagnant
    // → les vrais gagnants sont marqués LOST (bug du compte B).
    const betsSnapshot = await db.collection('bets')
      .where('draw_id', '==', drawId)
      .get();
 
    // Calcul du snapshot HORS transaction (lecture seule, draw déjà CLOSED = immuable)
    const snapshotTotals: Record<number, number> = {};
    for (let i = 1; i <= 9; i++) snapshotTotals[i] = 0;
 
    let totalPool = 0;
 
    betsSnapshot.docs.forEach(doc => {
      const bet = doc.data() as Bet;
      const num = Number(bet.number);
      const amt = Number(bet.amount);
 
      if (isNaN(num) || num < 1 || num > 9) return;
      if (isNaN(amt) || amt <= 0) return;
 
      snapshotTotals[num] = (snapshotTotals[num] || 0) + amt;
      totalPool += amt;
    });
 
    console.log(`[DrawAudit] Snapshot for ${drawId}: ${betsSnapshot.size} bets, Total: ${totalPool}`);
 
    const timestamp = new Date().toISOString();
    const hashContent = JSON.stringify({ snapshotTotals, totalPool, drawId, timestamp });
    const snapshotHash = crypto.createHash('sha256').update(hashContent).digest('hex');
 
    // Seule l'écriture finale est dans une transaction (atomique)
    await db.runTransaction(async (t) => {
      const drawDoc = await t.get(drawRef);
      const drawData = drawDoc.data() as Draw;
 
      if (drawData.status !== 'CLOSED') {
        throw new Error(`Unexpected status ${drawData.status} during Phase 2 snapshot.`);
      }
 
      // Vérification anti-doublon : si snapshotHash existe déjà, Phase 2 déjà faite
      if (drawData.snapshotHash) {
        console.log(`[Draw] Phase 2 already done for ${drawId}, skipping.`);
        return;
      }
 
      t.update(drawRef, {
        totalPool,
        snapshotTotals,
        snapshotHash,
        updated_at: timestamp
      });
    });
 
    auditData = { drawId, totalPool, snapshotHash, betCount: betsSnapshot.size };
 
    if (auditData) {
      await logAudit(AuditAction.CLOSE_DRAW, auditData);
    }
  }

  /**
   * ALGORITHME DE SÉLECTION DU GAGNANT (DÉTERMINISTE & AUDITABLE)
   *
   * Cas 1 : Un seul candidat → gagnant direct, pas de hash nécessaire.
   * Cas 2 : Plusieurs candidats → sélection via hash SHA256 du snapshotHash (seed).
   * Cas 3 : zeros.length === 1 → on exclut ce zéro du workingSet initial
   *          (peut être réintégré comme ZERO_SWAP si safetyTriggered).
   * Cas 4 : Tous à 0 / tous identiques → random déterministe via hash.
   */
  static resolveWinningNumber(
    snapshotTotals: Record<number, number>,
    seed: string
  ): {
    winner: number;
    zeros: number[];
    workingSet: number[];
    minTotal: number;
    candidates: number[];
    hashUsed?: string | undefined;
  } {
    const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];

    const zeros = numbers.filter(n => (Number(snapshotTotals[n]) || 0) === 0);
    const positive = numbers.filter(n => (Number(snapshotTotals[n]) || 0) > 0);

    // Si un seul zéro : on l'ignore pour garantir un gagnant réel
    let workingSet: number[];
    if (zeros.length === 1) {
      workingSet = positive;
    } else {
      workingSet = numbers;
    }

    const totals = workingSet.map(n => Number(snapshotTotals[n]) || 0);
    const minTotal = Math.min(...totals);
    const candidates = workingSet.filter(n => (Number(snapshotTotals[n]) || 0) === minTotal);

    console.log(`[Audit] resolveWinningNumber: zeros=${zeros}, workingSet=${workingSet}, minTotal=${minTotal}, candidates=${candidates}`);

    let winner: number;
    let hashUsed: string | undefined;

    if (candidates.length === 1) {
      winner = candidates[0]!;
    } else {
      hashUsed = crypto.createHash('sha256').update(seed).digest('hex');
      const hashInt = BigInt("0x" + hashUsed.substring(0, 16));
      const index = Number(hashInt % BigInt(candidates.length));
      winner = candidates[index]!;
    }

    return { winner, zeros, workingSet, minTotal, candidates, hashUsed };
  }

  /**
   * Resolves the draw based ONLY on the snapshot.
   *
   * FIX APPLIED:
   * [BUG FIX] Ajout de `payoutStatus: 'PENDING'` lors du passage en RESOLVED
   * → Sans ce champ initialisé, la query du scheduler
   *   `.where('payoutStatus', '==', 'PENDING')` ne retourne jamais ce draw,
   *   et aucun paiement n'est jamais déclenché.
   */
  static async resolveDraw(drawId: string): Promise<void> {
    let auditData: any = null;

    await db.runTransaction(async (t) => {
      const drawRef = db.collection('draws').doc(drawId);
      const drawDoc = await t.get(drawRef);

      if (!drawDoc.exists) throw new Error('Draw not found');
      const drawData = drawDoc.data() as Draw;

      if (drawData.status !== 'CLOSED') {
        throw new Error(`Draw must be CLOSED to resolve. Current status: ${drawData.status}`);
      }
      if (drawData.locked) {
        console.log(`Draw ${drawId} already locked, skipping resolution.`);
        return;
      }

      const snapshotTotals = drawData.snapshotTotals;
      const totalPool = drawData.totalPool || 0;
      const displayMultiplier = drawData.multiplier || 5;
      const snapshotHash = drawData.snapshotHash;

      if (!snapshotTotals || !snapshotHash) {
        throw new Error(`Critical Data Missing for Resolution (Snapshot or Hash). Draw: ${drawId}`);
      }

      // ÉTAPE 1 — SÉLECTION DU GAGNANT
      let { winner, zeros, workingSet, minTotal, candidates, hashUsed } =
        this.resolveWinningNumber(snapshotTotals, snapshotHash);

      // ÉTAPE 2 — CALCUL FINANCIER
      let totalWinnerBets = Number(snapshotTotals[winner]) || 0;
      let realMultiplier = displayMultiplier;
      let safetyTriggered = false;
      let fallbackUsed: string | null = null;

      const MAX_MULTIPLIER = 10;
      realMultiplier = Math.min(realMultiplier, MAX_MULTIPLIER);

      let totalPayout = totalWinnerBets * realMultiplier;

      // ÉTAPE 3 — VALIDATION & PLAFONNEMENT
      if (totalPayout > totalPool) {
        safetyTriggered = true;

        if (zeros.length === 1) {
          // CAS 2A : swap vers le zéro ignoré → aucun gagnant
          winner = zeros[0]!;
          realMultiplier = 0;
          totalWinnerBets = 0;
          totalPayout = 0;
          fallbackUsed = "ZERO_SWAP";
          console.log(`[Algorithm] Safety Triggered: Swapping to ignored zero: ${winner}`);
        } else {
          // CAS 2B : ajustement dynamique du multiplicateur
          realMultiplier = totalWinnerBets > 0 ? totalPool / totalWinnerBets : 0;
          realMultiplier = Math.min(realMultiplier, MAX_MULTIPLIER);
          totalPayout = totalWinnerBets * realMultiplier;
          fallbackUsed = "MULTIPLIER_ADJUST";
          console.log(`[Algorithm] Safety Triggered: Adjusting multiplier: ${realMultiplier}`);
        }
      }

      if (totalWinnerBets === 0) {
        realMultiplier = 0;
        totalPayout = 0;
      }

      // 🔒 ASSERTION FINALE
      if (totalWinnerBets * realMultiplier > totalPool) {
        throw new Error(
          `CRITICAL FAIL: Payout (${totalWinnerBets * realMultiplier}) would exceed pool (${totalPool})!`
        );
      }

      // FIX 3 : payoutStatus initialisé à 'PENDING' pour que le scheduler
      // puisse détecter ce draw et déclencher les paiements.
      t.update(drawRef, {
        status: 'RESOLVED',
        locked: true,
        payoutStatus: 'PENDING', // ← AJOUT CRITIQUE
        winningNumber: winner,
        realMultiplier,
        totalPool,
        snapshotTotals,
        resolvedAt: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      auditData = {
        drawId,
        seed: snapshotHash,
        hashUsed: hashUsed || "NONE (SINGLE CANDIDATE)",
        zeros,
        workingSet,
        minTotal,
        candidates,
        winner,
        totalWinnerBets,
        totalPool,
        displayMultiplier,
        realMultiplier,
        maxMultiplier: MAX_MULTIPLIER,
        totalPayout,
        safetyTriggered,
        fallbackUsed,
        timestamp: new Date().toISOString()
      };
    });

    if (auditData) {
      await logAudit(AuditAction.RESOLVE_DRAW, auditData);
    }
  }

  /**
   * Cancels a draw and refunds players.
   */
  static async cancelDraw(drawId: string, reason: string): Promise<void> {
    // Implementation for refunding bets
    // ... (to be expanded if needed)
  }
}