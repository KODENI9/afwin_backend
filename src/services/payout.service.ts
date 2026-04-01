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

    const { winningNumber, realMultiplier, multiplier } = drawData;
    const effectiveMultiplier = realMultiplier !== undefined ? realMultiplier : (multiplier || 5);

    if (winningNumber === undefined) {
      throw new Error('Draw resolution data missing');
    }

    let totalPaid = drawData.totalPayoutDistributed || 0;
    let processedInThisRun = 0;
    let hasMore = true;

    while (hasMore) {
      // Fetch a chunk of PENDING bets
      const chunkSnapshot = await db.collection('bets')
        .where('draw_id', '==', drawId)
        .where('status', '==', 'PENDING')
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

        let payoutAmount = 0;
        let betStatus: 'WON' | 'LOST' = 'LOST';
        
        if (Number(betData.number) === Number(winningNumber)){
          payoutAmount = Math.floor(betData.amount * effectiveMultiplier);
          betStatus = 'WON';
        }

        try {
          await db.runTransaction(async (t) => {
            // Check idempotency via transaction reference
            const existingTx = await t.get(
              db.collection('transactions').where('reference', '==', idempotencyKey).limit(1)
            );
            
            if (!existingTx.empty) {
              const currentBet = await t.get(betDoc.ref);
              if (currentBet.data()?.status === 'PENDING') {
                t.update(betDoc.ref, { 
                  status: betStatus,
                  payoutAmount,
                  resolvedAt: new Date().toISOString()
                });
              }
              return;
            }

            t.update(betDoc.ref, {
              status: betStatus,
              payoutAmount,
              resolvedAt: new Date().toISOString(),
              updated_at: new Date().toISOString()
            });

            if (payoutAmount > 0) {
              const profileRef = db.collection('profiles').doc(userId);
              const profileDoc = await t.get(profileRef);
              if (!profileDoc.exists) throw new Error(`Profile not found for user ${userId}`);

              const currentBalance = profileDoc.data()?.balance || 0;
              t.update(profileRef, { balance: currentBalance + payoutAmount });

              const transaction: Transaction = {
                user_id: userId,
                draw_id: drawId,
                type: 'payout',
                amount: payoutAmount,
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
                message: `Félicitations ! Vous avez gagné ${payoutAmount} CFA sur le tirage du ${drawData.draw_date}.`,
                type: 'win',
                read: false,
                created_at: new Date().toISOString()
              };
              t.set(db.collection('notifications').doc(), notification);

              // Traceability log
              logAudit(AuditAction.PAYOUT, { betId: betDoc.id, drawId }, 'SYSTEM', userId, payoutAmount, drawId);

              totalPaid += payoutAmount;
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

    // Finalize Draw Financials
    const commission = 0; // Logic for commission can be added here
    const profit = (drawData.totalPool || 0) - totalPaid;

    // CRITICAL SAFETY CHECK: Never payout more than the pool
    if (totalPaid > (drawData.totalPool || 0)) {
      console.error(`[CRITICAL] Payout overload for draw ${drawId}! Paid: ${totalPaid}, Pool: ${drawData.totalPool}`);
      await logAudit(AuditAction.MANUAL_ADJUSTMENT, { error: 'Payout exceeded totalPool', drawId, totalPaid, pool: drawData.totalPool }, 'CRITICAL_ERROR');
      // We don't mark as COMPLETED to allow manual fix
      return;
    }

    await drawRef.update({ 
      payoutStatus: 'COMPLETED',
      totalPayout: totalPaid,
      profit,
      commission,
      updated_at: new Date().toISOString()
    });

    console.log(`✅ Payout distribution complete for draw ${drawId}. Profit: ${profit} CFA.`);
    
    // Update Daily Stats
    const { AnalyticsService } = require('./analytics.service');
    await AnalyticsService.updateDailyStats(drawData.draw_date, {
      bets: drawData.totalPool || 0,
      payouts: totalPaid,
      referrals: 0, // Should be fetched from referral bonuses in this period
      drawId
    });

    await logAudit(AuditAction.PAYOUT_DISTRIBUTION, { drawId, totalPaid, profit, processedCount: processedInThisRun });
  }
}
