import cron from 'node-cron';
import { db } from '../config/firebase';
import { Draw } from '../types';
import { DrawService } from '../services/draw.service';
import { PayoutService } from '../services/payout.service';
import { logAudit, AuditAction } from '../services/audit.service';
import { createDailyDraws } from '../utils/time.utils';

const getTodayDate = () => new Date().toISOString().substring(0, 10);

/**
 * Vérifie si des draws existent déjà pour une date donnée.
 *
 * FIX : filtre sur 'draw_date' (champ réel du type Draw)
 * et non 'date' qui n'existe pas → query retournait toujours vide
 * → bootstrap recréait les draws à chaque redémarrage serveur.
 */
const drawsExistForDate = async (date: string): Promise<boolean> => {
  const snapshot = await db.collection('draws')
    .where('draw_date', '==', date)
    .limit(1)
    .get();
  return !snapshot.empty;
};

export const runMultiSlotCycle = async (): Promise<void> => {
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    const openExpired = await db.collection('draws')
      .where('status', '==', 'OPEN')
      .get();

    for (const doc of openExpired.docs) {
      const data = doc.data() as Draw;
      if (nowIso >= data.endTime) {
        console.log(`[Scheduler] Closing expired draw ${doc.id}...`);
        await DrawService.closeDraw(doc.id).catch(err =>
          console.error(`Failed to close ${doc.id}:`, err)
        );
      }
    }

    const closed = await db.collection('draws')
      .where('status', '==', 'CLOSED')
      .get();

    for (const doc of closed.docs) {
      if (doc.data().locked === true) {
        console.log(`[Scheduler] Draw ${doc.id} already locked, skipping.`);
        continue;
      }
      console.log(`[Scheduler] Resolving draw ${doc.id}...`);
      await DrawService.resolveDraw(doc.id).catch(err =>
        console.error(`Failed to resolve ${doc.id}:`, err)
      );
    }

    const resolved = await db.collection('draws')
      .where('status', '==', 'RESOLVED')
      .where('payoutStatus', '==', 'PENDING')
      .get();

    for (const doc of resolved.docs) {
      console.log(`[Scheduler] Distributing payouts for draw ${doc.id}...`);
      await PayoutService.distributePayouts(doc.id).catch(err =>
        console.error(`Failed to payout ${doc.id}:`, err)
      );
    }

  } catch (err) {
    console.error(`[Scheduler] Fatal error in cycle:`, err);
  }
};

export const startDrawScheduler = (): void => {
  cron.schedule('0 0 * * *', async () => {
    const today = getTodayDate();
    console.log(`[Scheduler] 00:00 — Generating daily time slots for ${today}...`);
    try {
      await createDailyDraws(today);
    } catch (err) {
      console.error('[Scheduler] Error in multi-slot creation:', err);
    }
  }, { timezone: 'Africa/Lome' });

  cron.schedule('* * * * *', async () => {
    console.log('[Scheduler] Checking for draw transitions...');
    await runMultiSlotCycle();
  }, { timezone: 'Africa/Lome' });

  // BOOTSTRAP IDEMPOTENT
  const today = getTodayDate();
  drawsExistForDate(today)
    .then(exists => {
      if (exists) {
        console.log(`[Scheduler] Bootstrap: draws already exist for ${today}, skipping creation.`);
      } else {
        console.log(`[Scheduler] Bootstrap: creating draws for ${today}...`);
        return createDailyDraws(today);
      }
    })
    .catch(err => console.error('[Scheduler] Bootstrap failed:', err));

  console.log('[Scheduler] Multi-Slot Automation Started (Lome Timezone)');
};