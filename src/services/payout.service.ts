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
      // Note: We normally expect RESOLVED, but if it was interrupted 
      // during payout, it stays RESOLVED.
      throw new Error(`Draw status must be RESOLVED. Status: ${drawData.status}`);
    }

    if (drawData.payoutStatus === 'COMPLETED') {
      console.log(`Payouts for draw ${drawId} already COMPLETED. Skipping.`);
      return;
    }

    // Mark as PROCESSING if not already
    if (drawData.payoutStatus !== 'PROCESSING') {
      await drawRef.update({ 
        payoutStatus: 'PROCESSING',
        totalPayoutDistributed: 0,
        updated_at: new Date().toISOString()
      });
      console.log(`Starting payout processing for draw ${drawId}...`);
    }

    const { winningNumber, multiplier } = drawData;
    if (winningNumber === undefined || multiplier === undefined) {
      throw new Error('Draw resolution data missing');
    }

    let totalPaid = drawData.totalPayoutDistributed || 0;
    let processedInThisRun = 0;
    let hasMore = true;

    while (hasMore) {
      // Fetch a chunk of PENDING bets
      const chunkSnapshot = await db.collection('bets')
        .where('draw_id', '==', drawId)
        .where('status', '==', 'pending')
        .limit(this.CHUNK_SIZE)
        .get();

      if (chunkSnapshot.empty) {
        hasMore = false;
        break;
      }

      console.log(`Processing chunk of ${chunkSnapshot.size} bets (Total so far: ${totalPaid} CFA)...`);

      for (const betDoc of chunkSnapshot.docs) {
        const betData = betDoc.data() as Bet;
        const userId = betData.user_id;
        const idempotencyKey = `PAYOUT_${drawId}_${betDoc.id}`;

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

        const betStatus = hasWin && hasLoss ? 'partial' : hasWin ? 'won' : 'lost';

        try {
          await db.runTransaction(async (t) => {
            // Check idempotency via transaction reference
            const existingTx = await t.get(
              db.collection('transactions').where('reference', '==', idempotencyKey).limit(1)
            );
            
            if (!existingTx.empty) {
              // Even if skipped, we verify the bet status isn't 'pending' anymore
              // to avoid infinite loops if it was partially updated before crash
              const currentBet = await t.get(betDoc.ref);
              if (currentBet.data()?.status === 'pending') {
                t.update(betDoc.ref, { status: betStatus });
              }
              return;
            }

            t.update(betDoc.ref, {
              entries: resolvedEntries,
              status: betStatus,
              totalPayout,
              updated_at: new Date().toISOString()
            });

            if (totalPayout > 0) {
              const profileRef = db.collection('profiles').doc(userId);
              const profileDoc = await t.get(profileRef);
              if (!profileDoc.exists) throw new Error(`Profile not found for user ${userId}`);

              const currentBalance = profileDoc.data()?.balance || 0;
              t.update(profileRef, { balance: currentBalance + totalPayout });

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
              t.set(db.collection('transactions').doc(), transaction);

              const notification: Notification = {
                user_id: userId,
                title: '🏆 Gain AF-WIN !',
                message: `Félicitations ! Vous avez gagné ${totalPayout} CFA sur le tirage du ${drawData.draw_date}.`,
                type: 'win',
                read: false,
                created_at: new Date().toISOString()
              };
              t.set(db.collection('notifications').doc(), notification);

              totalPaid += totalPayout;
            } else {
              // Still log a 0-amount transaction for idempotency
              t.set(db.collection('transactions').doc(), {
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
          processedInThisRun++;
        } catch (err) {
          console.error(`Error processing bet ${betDoc.id}:`, err);
        }
      }

      // Update progress on Draw document after each chunk
      await drawRef.update({ 
        totalPayoutDistributed: totalPaid,
        updated_at: new Date().toISOString()
      });
    }

    // Finalize
    await drawRef.update({ 
      payoutStatus: 'COMPLETED',
      updated_at: new Date().toISOString()
    });

    console.log(`✅ Payout distribution complete for draw ${drawId}. Total distributed: ${totalPaid} CFA.`);
    await logAudit(AuditAction.PAYOUT_DISTRIBUTION, { drawId, totalPaid, processedCount: processedInThisRun });
  }
}
