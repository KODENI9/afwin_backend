import { db } from '../config/firebase';
import { Draw, Bet } from '../types';
import { AuditAction, logAudit } from './audit.service';
import crypto from 'crypto';

export class DrawService {
  /**
   * Closes the draw for betting. Takes a snapshot of all bets.
   * Atomically transitions status from OPEN to CLOSED.
   */
  /**
   * Closes the draw for betting. Takes a snapshot of all bets.
   * Atomically transitions status from OPEN to CLOSED then performs the heavy counting.
   */
  static async closeDraw(drawId: string): Promise<void> {
    const drawRef = db.collection('draws').doc(drawId);
    let auditData: any = null;

    // --- PHASE 1: LOCKING (Atomic Transition) ---
    // This blocks all calls to placeBet immediately.
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
    // Now that no more bets can enter, we can safely count them.
    await db.runTransaction(async (t) => {
      const drawDoc = await t.get(drawRef);
      const drawData = drawDoc.data() as Draw;

      // In case we are retrying Phase 2, ensure it's still CLOSED
      if (drawData.status !== 'CLOSED') {
        throw new Error(`Unexpected status ${drawData.status} during Phase 2 snapshot.`);
      }

      const betsSnapshot = await t.get(db.collection('bets').where('draw_id', '==', drawId));
      
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

      // Security Hash
      const timestamp = new Date().toISOString();
      const hashContent = JSON.stringify({ snapshotTotals, totalPool, drawId, timestamp });
      const snapshotHash = crypto.createHash('sha256').update(hashContent).digest('hex');

      t.update(drawRef, {
        totalPool,
        snapshotTotals,
        snapshotHash,
        updated_at: timestamp
      });

      auditData = { drawId, totalPool, snapshotHash, betCount: betsSnapshot.size };
    });

    if (auditData) {
      await logAudit(AuditAction.CLOSE_DRAW, auditData);
    }
  }

  /**
   * STRICT WINNING ALGORITHM (Production Ready)
   * 
   * Case 1: Unique minimum > 0 -> Returns that number.
   * Case 2: Mix of 0 and Positive -> Ignores 0s, calculate on positives only.
   * Case 3: 0 + Identical Positives -> Ignores 0s, random among positives.
   * Case 4: All Positives Identical (>0) -> Random 1-9 (Full random).
   * Case 5: Shared Minimum -> Random among min candidates.
   * Case 6: All 0 -> Random 1-9 (Full random).
   */
  /**
   * ÉTAPE 1 — SÉLECTION DU GAGNANT (DÉTERMINISTE)
   * 
   * @param snapshotTotals Totaux des mises par chiffre 1-9
   * @param seed La graine déterministe (doit être le snapshotHash)
   */
  static resolveWinningNumber(snapshotTotals: Record<number, number>, seed: string): { 
    winner: number, 
    zeros: number[], 
    workingSet: number[], 
    minTotal: number, 
    candidates: number[],
    hashUsed?: string | undefined
  } {
    const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    
    // 1. Séparer les valeurs
    const zeros = numbers.filter(n => (Number(snapshotTotals[n]) || 0) === 0);
    const positive = numbers.filter(n => (Number(snapshotTotals[n]) || 0) > 0);

    // 2. Définir le working set (Logic Fix: Toujours inclure les Zéros s'ils existent)
    // Si un seul zéro → on l'ignore pour garantir un gagnant réel
   let workingSet: number[];

    if (zeros.length === 1) {
      workingSet = positive; // 🔥 on ignore le seul zéro
    } else {
      workingSet = numbers;
    }

    // 3. Trouver le minimum
    const totals = workingSet.map(n => Number(snapshotTotals[n]) || 0);
    const minTotal = Math.min(...totals);
    const candidates = workingSet.filter(n => (Number(snapshotTotals[n]) || 0) === minTotal);

    console.log(`[Audit] resolveWinningNumber: zeros=${zeros}, workingSet=${workingSet}, minTotal=${minTotal}, candidates=${candidates}`);

    // 4. Choisir le gagnant de manière DÉTERMINISTE (Auditable)
    let winner: number;
    let hashUsed: string | undefined;

    if (candidates.length === 1) {
      winner = candidates[0]!;
    } else {
      // Si plusieurs candidats, on utilise le hash de la seed (snapshotHash)
      hashUsed = crypto.createHash('sha256').update(seed).digest('hex');
      // Utilisation du modulo sur les 16 premiers caractères (64 bits) pour l'index
      const hashInt = BigInt("0x" + hashUsed.substring(0, 16));
      const index = Number(hashInt % BigInt(candidates.length));
      winner = candidates[index]!;
    }

    return { winner, zeros, workingSet, minTotal, candidates, hashUsed };
  }

  /**
   * Resolves the draw based ONLY on the snapshot.
   * Identifies the winning number using refined logic.
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

      // ÉTAPE 1 — SÉLECTION DU GAGNANT (DÉTERMINISTE via snapshotHash)
      let { winner, zeros, workingSet, minTotal, candidates, hashUsed } = this.resolveWinningNumber(snapshotTotals, snapshotHash);
      
      // ÉTAPE 2 — CALCUL FINANCIER INITIAL
      let totalWinnerBets = Number(snapshotTotals[winner]) || 0;
      let realMultiplier = displayMultiplier;
      let safetyTriggered = false;
      let fallbackUsed: string | null = null;

      // ÉTAPE 3 — VALIDATION & PLAFONNEMENT
      const MAX_MULTIPLIER = 10;
      
      // Plafonnement initial au max autorisé
      realMultiplier = Math.min(realMultiplier, MAX_MULTIPLIER);

      let totalPayout = totalWinnerBets * realMultiplier;

      if (totalPayout > totalPool) {
        safetyTriggered = true;
        // CAS 2 — RISQUE DE PERTE
        if (zeros.length === 1) {
          // CAS 2A — un seul zéro existait -> utiliser ce zéro (Aucun Gain)
          winner = zeros[0]!;
          realMultiplier = 0;
          totalWinnerBets = 0;
          totalPayout = 0;
          fallbackUsed = "ZERO_SWAP";
          console.log(`[Algorithm] Safety Triggered: Swapping to ignored zero: ${winner}`);
        } else {
          // CAS 2B — sinon -> ajuster le multiplicateur dynamiquement
          realMultiplier = totalWinnerBets > 0 ? totalPool / totalWinnerBets : 0;
          // Re-cap au plafond si besoin (théoriquement déjà inclus dans la division)
          realMultiplier = Math.min(realMultiplier, MAX_MULTIPLIER);
          totalPayout = totalWinnerBets * realMultiplier;
          fallbackUsed = "MULTIPLIER_ADJUST";
          console.log(`[Algorithm] Safety Triggered: Adjusting multiplier: ${realMultiplier}`);
        }
      }

      // SÉCURITÉ SPÉCIALE : Aucun pari gagnant -> realMultiplier = 0
      if (totalWinnerBets === 0) {
        realMultiplier = 0;
        totalPayout = 0;
      }

      // 🔒 CONTRAINTE ABSOLUE (Assertion Finale)
      if (totalWinnerBets * realMultiplier > totalPool) {
        throw new Error(`CRITICAL FAIL: Payout (${totalWinnerBets * realMultiplier}) would exceed pool (${totalPool})!`);
      }

      // Enregistrement de l'état final
      t.update(drawRef, {
        status: 'RESOLVED',
        locked: true,
        winningNumber: winner,
        realMultiplier,
        totalPool,
        snapshotTotals,
        resolvedAt: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      // 📊 LOGS AUDIT COMPLETS (Auditable par un tiers)
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
