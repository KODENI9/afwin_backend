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
    let auditData: any = null;

    await db.runTransaction(async (t) => {
      const drawRef = db.collection('draws').doc(drawId);
      const drawDoc = await t.get(drawRef);

      if (!drawDoc.exists) throw new Error('Draw not found');
      const drawData = drawDoc.data() as Draw;

      // Strict check that the draw is OPEN
      if (drawData.status !== 'OPEN') {
        throw new Error(`Draw ${drawId} is not OPEN (current status: ${drawData.status})`);
      }

      // 1. Snapshot totals - Ensure strict 1-9 range and valid amounts
      const betsSnapshot = await t.get(db.collection('bets').where('draw_id', '==', drawId));
      
      const snapshotTotals: Record<number, number> = {};
      for (let i = 1; i <= 9; i++) snapshotTotals[i] = 0;

      let totalPool = 0;
      betsSnapshot.docs.forEach(doc => {
        const bet = doc.data() as Bet;
        const num = Number(bet.number);
        const amt = Number(bet.amount);

        if (isNaN(num) || num < 1 || num > 9) {
          console.warn(`[Draw] Skipping invalid entry number ${bet.number} for draw ${drawId}`);
          return;
        }
        if (isNaN(amt) || amt <= 0) return;

        snapshotTotals[num] = (snapshotTotals[num] || 0) + amt;
        totalPool += amt;
      });

      // 2. Security Hash
      const timestamp = new Date().toISOString();
      const hashContent = JSON.stringify({ snapshotTotals, totalPool, drawId, timestamp });
      const snapshotHash = crypto.createHash('sha256').update(hashContent).digest('hex');

      // 3. Update Draw
      t.update(drawRef, {
        status: 'CLOSED',
        totalPool,
        snapshotTotals,
        snapshotHash,
        closedAt: timestamp,
        updated_at: timestamp
      });

      auditData = { drawId, totalPool, snapshotHash };
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
  static resolveWinningNumber(snapshotTotals: Record<number, number>, totalPool: number): number {
    const validNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    
    // Extract entries
    const entries = validNumbers.map(n => ({
      number: n,
      total: Number(snapshotTotals[n] || 0)
    }));

    // Identify positive entries (bets > 0)
    const positiveEntries = entries.filter(e => e.total > 0);
    const uniqueAmounts = new Set(positiveEntries.map(e => e.total));

    // --- FULL RANDOM CONDITIONS (CAS 4 & 6) ---
    // If all values are 0 (CAS 6) OR ALL 9 values are identical (CAS 4)
    if (positiveEntries.length === 0 || (positiveEntries.length === 9 && uniqueAmounts.size === 1)) {
      const winner = crypto.randomInt(1, 10);
      console.log(`[Algorithm] Full Random Triggered: Winner=${winner}`);
      return winner;
    }

    // --- PARTIAL MINIMUM SELECTION (CAS 1, 2, 3, 5) ---
    // Work only on positive entries, ignore 0s.
    const minAmount = Math.min(...positiveEntries.map(e => e.total));
    const candidates = positiveEntries
      .filter(e => e.total === minAmount)
      .map(e => e.number);

    // Return random among min candidates (Handles Cas 3, 5, 1)
    const winner = candidates[crypto.randomInt(0, candidates.length)]!;
    
    console.log(`[Algorithm] Success: Winner=${winner}, MinAmount=${minAmount}, Candidates=${candidates}`);
    return winner;
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

      // ANTI-RACE CONDITION: State + Lock Check
      if (drawData.status !== 'CLOSED') {
        throw new Error(`Draw must be CLOSED to resolve. Current status: ${drawData.status}`);
      }
      if (drawData.locked) {
        console.log(`Draw ${drawId} already locked, skipping resolution.`);
        return;
      }

      const snapshot = drawData.snapshotTotals;
      const totalPool = drawData.totalPool || 0;
      if (!snapshot) throw new Error('No snapshot found for draw resolution');

      // Use the Profit-Guarantee algorithm
      const winningNumber = this.resolveWinningNumber(snapshot, totalPool);

      // Multiplier Calculations
      const multiplier = drawData.multiplier || 5;

      // Finalize State and LOCK immediately
      t.update(drawRef, {
        status: 'RESOLVED',
        locked: true,
        winningNumber,
        resolvedAt: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      auditData = { 
        drawId, 
        winningNumber, 
        totalPool, 
        multiplier,
        payoutAmount: (snapshot[winningNumber] || 0) * multiplier
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
