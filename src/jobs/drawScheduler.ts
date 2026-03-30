import cron from 'node-cron';
import { db } from '../config/firebase';
import { Draw } from '../types';
import { DrawService } from '../services/draw.service';
import { PayoutService } from '../services/payout.service';
import { logAudit, AuditAction } from '../services/audit.service';
import { createDailyDraws } from '../utils/time.utils';

/**
 * PRODUCTION READY SCHEDULER
 * Handles multi-slot draw management with strict idempotence.
 */

const getTodayDate = () => new Date().toISOString().substring(0, 10);

/**
 * Main Status Transition Logic (EVERY MINUTE)
 * 1. CLOSE draws where now >= endTime
 * 2. RESOLVE draws where status === 'CLOSED'
 * 3. DISTRIBUTE payouts where status === 'RESOLVED'
 */
export const runMultiSlotCycle = async (): Promise<void> => {
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    // 1. Find draws to CLOSE (OPEN and expired)
    const openExpired = await db.collection('draws')
      .where('status', '==', 'OPEN')
      .get();

    for (const doc of openExpired.docs) {
      const data = doc.data() as Draw;
      if (nowIso >= data.endTime) {
        console.log(`[Scheduler] Closing expired draw ${doc.id}...`);
        await DrawService.closeDraw(doc.id).catch(err => console.error(`Failed to close ${doc.id}:`, err));
      }
    }

    // 2. Find draws to RESOLVE (CLOSED)
    // NOTE: We do NOT use .where('locked', '!=', true) because Firestore requires a
    // composite index for inequality filters on multiple fields, and the query silently
    // returns 0 results when the `locked` field is missing on a document.
    // The lock check is already enforced inside DrawService.resolveDraw().
    const closed = await db.collection('draws')
      .where('status', '==', 'CLOSED')
      .get();

    for (const doc of closed.docs) {
      if (doc.data().locked === true) {
        console.log(`[Scheduler] Draw ${doc.id} already locked, skipping.`);
        continue;
      }
      console.log(`[Scheduler] Resolving draw ${doc.id}...`);
      await DrawService.resolveDraw(doc.id).catch(err => console.error(`Failed to resolve ${doc.id}:`, err));
    }

    // 3. Find draws to PAYOUT (RESOLVED and payoutStatus PENDING)
    const resolved = await db.collection('draws')
      .where('status', '==', 'RESOLVED')
      .where('payoutStatus', '==', 'PENDING')
      .get();

    for (const doc of resolved.docs) {
      console.log(`[Scheduler] Distributing payouts for draw ${doc.id}...`);
      await PayoutService.distributePayouts(doc.id).catch(err => console.error(`Failed to payout ${doc.id}:`, err));
    }

  } catch (err) {
    console.error(`[Scheduler] Fatal error in cycle:`, err);
  }
};

export const startDrawScheduler = (): void => {
  // --- JOB A: MASS CREATION at 00:00 ---
  cron.schedule('0 0 * * *', async () => {
    console.log('[Scheduler] 00:00 — Generating daily time slots...');
    try {
      await createDailyDraws(getTodayDate());
    } catch (err) {
      console.error('[Scheduler] Error in multi-slot creation:', err);
    }
  }, { timezone: 'Africa/Lome' });

  // --- JOB B: PER-MINUTE AUTOMATION ---
  cron.schedule('* * * * *', async () => {
    console.log('[Scheduler] Checking for draw transitions...');
    await runMultiSlotCycle();
  }, { timezone: 'Africa/Lome' });

  // BOOTSTRAP: Ensure draws exist for today when server starts
  createDailyDraws(getTodayDate()).catch(err => console.error('[Scheduler] Bootstrap failed:', err));

  console.log('[Scheduler] Multi-Slot Automation Started (Lome Timezone)');
};
