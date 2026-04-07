import { db } from '../config/firebase';
import { Draw, Bet, Transaction, Notification } from '../types';
import { AuditAction, logAudit } from './audit.service';

export class PayoutService {

  /**
   * Distributes payouts for a resolved draw.
   *
   * FIXES APPLIED:
   * 1. [BUG FIX] Query `.where()` remplacé par DocumentReference fixe
   * 2. [BUG FIX] totalPaid précalculé hors transaction
   * 3. [BUG FIX] Toutes les lectures AVANT toutes les écritures dans la transaction
   *    → Firestore interdit un t.get() après un t.update() dans la même transaction
   */
  static async distributePayouts(drawId: string, collection: string = 'draws'): Promise<void> {
    const drawRef = db.collection(collection).doc(drawId);
    const drawDoc = await drawRef.get();

    if (!drawDoc.exists) throw new Error(`Draw not found in collection '${collection}'`);
    const drawData = drawDoc.data() as Draw;

    if (drawData.status !== 'RESOLVED' && drawData.status !== 'CLOSED') {
      throw new Error(`Draw status must be RESOLVED. Status: ${drawData.status}`);
    }

    if (drawData.payoutStatus === 'COMPLETED') {
      console.log(`Payouts for draw ${drawId} already COMPLETED.`);
      return;
    }

    await drawRef.update({
      payoutStatus: 'PROCESSING',
      updated_at: new Date().toISOString()
    });

    const { winningNumber, realMultiplier, multiplier } = drawData;
    const effectiveMultiplier = realMultiplier !== undefined ? realMultiplier : (multiplier || 5);

    const snapshot = await db.collection('bets')
      .where('draw_id', '==', drawId)
      .get();

    console.log(`Processing ${snapshot.size} bets for draw ${drawId}...`);

    // Précalcul du totalPaid hors transaction
    let totalPaid = 0;
    for (const betDoc of snapshot.docs) {
      const betData = betDoc.data() as Bet;
      const isLate = betData.createdAt && drawData.closedAt &&
        (new Date(betData.createdAt).getTime() > new Date(drawData.closedAt).getTime());
      if (isLate) continue;
      const isWinner = Number(betData.number) === Number(winningNumber);
      if (isWinner) {
        totalPaid += Math.floor(betData.amount * effectiveMultiplier);
      }
    }

    // Boucle principale
    for (const betDoc of snapshot.docs) {
      const betId = betDoc.id;
      const betData = betDoc.data() as Bet;
      const userId = betData.user_id;

      const isLate = betData.createdAt && drawData.closedAt &&
        (new Date(betData.createdAt).getTime() > new Date(drawData.closedAt).getTime());

      if (isLate) {
        await betDoc.ref.update({
          status: 'LOST',
          payoutAmount: 0,
          metadata: { error: 'PHANTOM_BET_DETECTED' }
        });
        continue;
      }

      const idempotencyKey = `PAYOUT_${drawId}_${betId}`;
      const txRef = db.collection('transactions').doc(idempotencyKey);
      const profileRef = db.collection('profiles').doc(userId);

      const isWinner = Number(betData.number) === Number(winningNumber);
      const payoutAmount = isWinner ? Math.floor(betData.amount * effectiveMultiplier) : 0;
      const betStatus: 'WON' | 'LOST' = isWinner ? 'WON' : 'LOST';

      await db.runTransaction(async (t) => {
        // ── TOUTES LES LECTURES EN PREMIER ──────────────────────
        const existingTx = await t.get(txRef);
        const profileDoc = await t.get(profileRef);
        // ────────────────────────────────────────────────────────

        // ── ENSUITE LES ÉCRITURES ────────────────────────────────
        t.update(betDoc.ref, {
          status: betStatus,
          payoutAmount,
          resolvedAt: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

        if (existingTx.exists) return;

        if (payoutAmount > 0) {
          const currentBalance = profileDoc.data()?.balance || 0;
          t.update(profileRef, { balance: currentBalance + payoutAmount });

          t.set(txRef, {
            user_id: userId,
            draw_id: drawId,
            type: 'payout',
            amount: payoutAmount,
            provider: 'System',
            reference: idempotencyKey,
            status: 'approved',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });

          t.set(db.collection('notifications').doc(), {
            user_id: userId,
            title: '🏆 Gain AF-WIN !',
            message: `Félicitations ! Vous avez gagné ${payoutAmount} CFA.`,
            type: 'win',
            read: false,
            created_at: new Date().toISOString()
          });
        }
        // ────────────────────────────────────────────────────────
      });
    }

    const profit = (drawData.totalPool || 0) - totalPaid;

    await drawRef.update({
      payoutStatus: 'COMPLETED',
      totalPayout: totalPaid,
      profit,
      updated_at: new Date().toISOString()
    });

    console.log(`✅ Payout terminé pour ${drawId}. Total payé: ${totalPaid} CFA. Profit: ${profit} CFA.`);
  }
}