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
   * Refined logic to determine the winning number based on various cases.
   * Uses crypto.randomInt for unbiased randomization.
   */
  static resolveWinningNumber(snapshotTotals: Record<number, number>): number {
    // Strict filtering: only 1-9
    const validNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    
    // Calculate totals for each valid number
    const entries = validNumbers.map(n => ({
      number: n,
      total: Number(snapshotTotals[n] || 0)
    }));

    const allZero = entries.every(e => e.total === 0);

    // Case: No bets placed. Selecting random number 1-9 (inclusive).
    // Use crypto.randomInt(min, max) where max is exclusive.
    if (allZero) {
      const winner = crypto.randomInt(1, 10); 
      console.log(`[Draw] No bets placed. Selecting random number: ${winner}`);
      return winner;
    }

    // Filter out 0s if there are positive values (only consider numbers with bets)
    const positiveEntries = entries.filter(e => e.total > 0);

    // Find the minimum total among those with bets
    const minTotal = Math.min(...positiveEntries.map(e => e.total));
    const candidates = positiveEntries
      .filter(e => e.total === minTotal)
      .map(e => e.number);

    if (candidates.length === 1) {
      console.log(`[Draw] Unique winner found: ${candidates[0]} with total ${minTotal}`);
      return candidates[0]!;
    }

    // Ties: Randomly pick one among candidates using crypto.randomInt
    const randomIndex = crypto.randomInt(0, candidates.length);
    const winner = candidates[randomIndex]!;
    console.log(`[Draw] Tie detected for total ${minTotal}. Candidates: ${candidates.join(', ')}. Winner: ${winner}`);
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

      if (drawData.status !== 'CLOSED') {
        throw new Error(`Draw must be CLOSED to resolve. Current status: ${drawData.status}`);
      }
      if (drawData.locked) {
        console.log(`Draw ${drawId} already locked, skipping resolution.`);
        return;
      }

      const snapshot = drawData.snapshotTotals;
      if (!snapshot) throw new Error('No snapshot found for draw resolution');

      // (Optional) Verify snapshotHash here if needed for extreme security
      // ...

      // Use the refined algorithm
      const winningNumber = this.resolveWinningNumber(snapshot);

      // 2. Multiplier Calculations
      const multiplier = drawData.multiplier || 5;

      // 3. Finalize State
      t.update(drawRef, {
        status: 'RESOLVED',
        locked: true,
        winningNumber,
        resolvedAt: new Date().toISOString()
      });

      auditData = { 
        drawId, 
        winningNumber, 
        totalPool: drawData.totalPool, 
        multiplier 
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
