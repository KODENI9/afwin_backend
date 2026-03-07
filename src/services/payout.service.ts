import { db } from '../config/firebase';
import { Draw, Bet, Transaction, Notification } from '../types';
import { AuditAction, logAudit } from './audit.service';

export class PayoutService {
  /**
   * Distributes payouts for a resolved draw.
   * Handles multi-entry bets: each entry is evaluated independently.
   * Uses idempotency keys to ensure crash-safety.
   */
  static async distributePayouts(drawId: string): Promise<void> {
    const drawRef = db.collection('draws').doc(drawId);
    const drawDoc = await drawRef.get();

    if (!drawDoc.exists) throw new Error('Draw not found');
    const drawData = drawDoc.data() as Draw;

    if (drawData.status !== 'RESOLVED') {
      throw new Error(`Draw must be RESOLVED to distribute payouts. Status: ${drawData.status}`);
    }

    const { winningNumber, multiplier } = drawData;
    if (winningNumber === undefined || multiplier === undefined) {
      throw new Error('Draw resolution data missing');
    }

    // Fetch ALL pending bets for this draw (multi-entry format)
    const allBetsSnapshot = await db.collection('bets')
      .where('draw_id', '==', drawId)
      .where('status', '==', 'pending')
      .get();

    if (allBetsSnapshot.empty) {
      console.log(`No pending bets to process for draw ${drawId}.`);
      return;
    }

    console.log(`Processing payouts for ${allBetsSnapshot.size} bets...`);

    let totalPaid = 0;

    for (const betDoc of allBetsSnapshot.docs) {
      const betData = betDoc.data() as Bet;
      const userId = betData.user_id;
      const idempotencyKey = `PAYOUT_${drawId}_${betDoc.id}`;

      // Evaluate each entry against the winning number
      let totalPayout = 0;
      let hasWin = false;
      let hasLoss = false;

      const resolvedEntries = (betData.entries || []).map(entry => {
        if (entry.number === winningNumber) {
          const entryPayout = Math.floor(entry.amount * multiplier);
          totalPayout += entryPayout;
          hasWin = true;
          return { ...entry, status: 'won' as const, payout: entryPayout };
        } else {
          hasLoss = true;
          return { ...entry, status: 'lost' as const, payout: 0 };
        }
      });

      // Determine overall bet status
      const betStatus = hasWin && hasLoss ? 'partial'
        : hasWin ? 'won'
        : 'lost';

      try {
        await db.runTransaction(async (t) => {
          // Idempotency: skip if already processed
          const existingTx = await t.get(
            db.collection('transactions').where('reference', '==', idempotencyKey).limit(1)
          );
          if (!existingTx.empty) {
            console.log(`Bet ${betDoc.id} already processed, skipping.`);
            return;
          }

          // Update the Bet document with resolved entries and status
          t.update(betDoc.ref, {
            entries: resolvedEntries,
            status: betStatus,
            totalPayout,
            updated_at: new Date().toISOString()
          });

          if (totalPayout > 0) {
            // Credit winner's balance
            const profileRef = db.collection('profiles').doc(userId);
            const profileDoc = await t.get(profileRef);
            if (!profileDoc.exists) throw new Error(`Profile not found for user ${userId}`);

            const currentBalance = profileDoc.data()?.balance || 0;
            t.update(profileRef, { balance: currentBalance + totalPayout });

            // Log payout transaction
            const txRef = db.collection('transactions').doc();
            const transaction: Transaction = {
              user_id: userId,
              draw_id: drawId,
              type: 'payout',
              amount: totalPayout,
              provider: 'System',
              reference: idempotencyKey,
              status: 'approved',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            };
            t.set(txRef, transaction);

            // Send win notification
            const wonEntries = resolvedEntries.filter(e => e.status === 'won');
            const wonDesc = wonEntries.map(e => `chiffre ${e.number} (+${e.payout} CFA)`).join(', ');
            const notifRef = db.collection('notifications').doc();
            const notification: Notification = {
              user_id: userId,
              title: '🏆 Gain AF-WIN !',
              message: `Félicitations ! Vous avez gagné ${totalPayout} CFA sur le tirage du ${drawData.draw_date}. (${wonDesc})`,
              type: 'win',
              read: false,
              created_at: new Date().toISOString()
            };
            t.set(notifRef, notification);

            totalPaid += totalPayout;
          } else {
            // Log idempotency marker even for losses, to prevent reprocessing
            const txRef = db.collection('transactions').doc();
            t.set(txRef, {
              user_id: userId,
              draw_id: drawId,
              type: 'payout',
              amount: 0,
              provider: 'System',
              reference: idempotencyKey,
              status: 'approved',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            });
          }
        });
      } catch (err) {
        console.error(`Failed to process payout for bet ${betDoc.id}:`, err);
        // continue to next bet; scheduler will retry this one
      }
    }

    // Update draw with final payout stats
    await drawRef.update({ totalPayoutDistributed: totalPaid });
    await logAudit(AuditAction.PAYOUT_DISTRIBUTION, { drawId, totalPaid });
  }
}
