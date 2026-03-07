import cron from 'node-cron';
import { db } from '../config/firebase';
import { Draw } from '../types';
import { DrawService } from '../services/draw.service';
import { PayoutService } from '../services/payout.service';
import { logAudit, AuditAction } from '../services/audit.service';

const getTodayDate = () => new Date().toISOString().substring(0, 10);

/**
 * Ensures a draw document exists for today.
 */
export const ensureTodayDraw = async (): Promise<string> => {
  const today = getTodayDate();
  const drawsRef = db.collection('draws');
  const existing = await drawsRef.where('draw_date', '==', today).limit(1).get();

  if (!existing.empty) {
    const doc = existing.docs[0];
    if (doc) return doc.id;
  }

  const newDraw: Draw = {
    draw_date: today,
    status: 'OPEN',
    totalPool: 0,
    multiplier: 5, // Default multiplier
    commissionRate: 0.10, // Default 10%
    created_at: new Date().toISOString(),
  };

  const ref = await drawsRef.add(newDraw);
  console.log(`[Scheduler] Created draw for ${today} — id: ${ref.id}`);
  return ref.id;
};

/**
 * Main cycle: Close -> Resolve -> Payout
 */
export const runDrawCycle = async (): Promise<void> => {
  const today = getTodayDate();
  const snapshot = await db.collection('draws')
    .where('draw_date', '==', today)
    .limit(1)
    .get();

  if (snapshot.empty) {
    console.log('[Scheduler] No draw found for today.');
    return;
  }

  const drawDoc = snapshot.docs[0];
  if (!drawDoc) {
    console.log('[Scheduler] Draw document is unexpectedly undefined.');
    return;
  }
  const drawId = drawDoc.id;
  const drawData = drawDoc.data() as Draw;

  try {
    // 1. Close (if not already closed/resolved)
    if (drawData.status === 'OPEN') {
      console.log(`[Scheduler] Closing draw ${drawId}...`);
      await DrawService.closeDraw(drawId);
    }

    // 2. Resolve (if closed)
    const updatedDraw = await db.collection('draws').doc(drawId).get();
    const updatedStatus = updatedDraw.data()?.status;
    if (updatedStatus === 'CLOSED') {
      console.log(`[Scheduler] Resolving draw ${drawId}...`);
      await DrawService.resolveDraw(drawId);
    }

    // 3. Payout (if resolved)
    const resolvedDraw = await db.collection('draws').doc(drawId).get();
    if (resolvedDraw.data()?.status === 'RESOLVED') {
      console.log(`[Scheduler] Distributing payouts for draw ${drawId}...`);
      await PayoutService.distributePayouts(drawId);
    }
  } catch (err) {
    console.error(`[Scheduler] Error in draw cycle for ${drawId}:`, err);
    await logAudit(AuditAction.MANUAL_ADJUSTMENT, { error: (err as Error).message, drawId }, 'SYSTEM_ERROR');
  }
};

export const startDrawScheduler = (): void => {
  // 00:00 every day → ensure draw exists for today
  cron.schedule('0 0 * * *', async () => {
    console.log('[Scheduler] 00:00 — Ensuring today\'s draw exists...');
    try {
      await ensureTodayDraw();
    } catch (err) {
      console.error('[Scheduler] Error creating draw:', err);
    }
  }, { timezone: 'Africa/Abidjan' });

  // 17:45 every day → CLOSE the draw (no more bets)
  cron.schedule('45 17 * * *', async () => {
    console.log('[Scheduler] 17:45 — Closing today\'s draw...');
    const today = getTodayDate();
    const snapshot = await db.collection('draws').where('draw_date', '==', today).limit(1).get();
    if (!snapshot.empty && snapshot.docs[0]) {
      await DrawService.closeDraw(snapshot.docs[0].id);
    }
  }, { timezone: 'Africa/Abidjan' });

  // 18:00 every day → RESOLVE and PAYOUT
  cron.schedule('0 18 * * *', async () => {
    console.log('[Scheduler] 18:00 — Resolving and paying out today\'s draw...');
    await runDrawCycle();
  }, { timezone: 'Africa/Abidjan' });

  console.log('[Scheduler] Parimutuel Scheduler started (00:00 init, 17:45 close, 18:00 resolve)');
};
