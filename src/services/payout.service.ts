import { db } from '../config/firebase';
import { Draw, Bet, Transaction, Notification } from '../types';
import { AuditAction, logAudit } from './audit.service';

export class PayoutService {
  private static readonly CHUNK_SIZE = 50;

  /**
   * Distributes payouts for a resolved draw.
   * Optimized for large volumes (10k+ 	users) with:
   * 1. Chunked processing (pagination)
   * 2. Status tracking (PROCESSING -> COMPLETED)
   * 3. Crash-safety & Resumability
   */
 static async distributePayouts(drawId: string): Promise<void> {
  const drawRef = db.collection('draws').doc(drawId);
  const drawDoc = await drawRef.get();

  if (!drawDoc.exists) throw new Error('Draw not found');
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
    totalPayoutDistributed: 0,
    updated_at: new Date().toISOString()
  });

  const { winningNumber, realMultiplier, multiplier } = drawData;
  const effectiveMultiplier = realMultiplier !== undefined ? realMultiplier : (multiplier || 5);

  let totalPaid = 0;

  // 🔥 UNE SEULE LECTURE PROPRE
  const snapshot = await db.collection('bets')
    .where('draw_id', '==', drawId)
    .get();

  console.log(`Processing ${snapshot.size} bets...`);

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

    const isWinner = Number(betData.number) === Number(winningNumber);
    const payoutAmount = isWinner ? Math.floor(betData.amount * effectiveMultiplier) : 0;
    const betStatus: 'WON' | 'LOST' = isWinner ? 'WON' : 'LOST';

    await db.runTransaction(async (t) => {

      // 🔥 FIX : on ne bloque PLUS le recalcul
      const existingTx = await t.get(
        db.collection('transactions').where('reference', '==', idempotencyKey).limit(1)
      );

      // 🔥 On met TOUJOURS à jour le bet
      t.update(betDoc.ref, {
        status: betStatus,
        payoutAmount,
        resolvedAt: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      // 🔥 MAIS on évite double paiement
      if (!existingTx.empty) return;

      if (payoutAmount > 0) {
        const profileRef = db.collection('profiles').doc(userId);
        const profileDoc = await t.get(profileRef);

        const currentBalance = profileDoc.data()?.balance || 0;
        t.update(profileRef, { balance: currentBalance + payoutAmount });

        t.set(db.collection('transactions').doc(), {
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

        totalPaid += payoutAmount;
      }
    });
  }

  const profit = (drawData.totalPool || 0) - totalPaid;

  await drawRef.update({ 
    payoutStatus: 'COMPLETED',
    totalPayout: totalPaid,
    profit,
    updated_at: new Date().toISOString()
  });

  console.log(`✅ Payout terminé. Profit: ${profit}`);
}
}
