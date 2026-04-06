import cron from 'node-cron';
import { db } from '../config/firebase';
import { Draw, FlashDraw } from '../types';
import { DrawService } from '../services/draw.service';
import { PayoutService } from '../services/payout.service';
import { FlashService } from '../services/flash.service';
import { createDailyDraws } from '../utils/time.utils';

const getTodayDate = () => new Date().toISOString().substring(0, 10);

const drawsExistForDate = async (date: string): Promise<boolean> => {
  const snapshot = await db.collection('draws')
    .where('draw_date', '==', date)
    .limit(1)
    .get();
  return !snapshot.empty;
};

/**
 * Cycle principal toutes les minutes — Draws normaux.
 */
export const runMultiSlotCycle = async (): Promise<void> => {
  const nowIso = new Date().toISOString();

  try {
    // 1. Fermer les draws OPEN expirés
    const openExpired = await db.collection('draws')
      .where('status', '==', 'OPEN')
      .get();
    for (const doc of openExpired.docs) {
      const data = doc.data() as Draw;
      if (nowIso >= data.endTime) {
        console.log(`[Scheduler] Closing draw ${doc.id}...`);
        await DrawService.closeDraw(doc.id).catch(err =>
          console.error(`Failed to close ${doc.id}:`, err)
        );
      }
    }

    // 2. Résoudre les draws CLOSED
    const closed = await db.collection('draws')
      .where('status', '==', 'CLOSED')
      .get();
    for (const doc of closed.docs) {
      if (doc.data().locked === true) continue;
      console.log(`[Scheduler] Resolving draw ${doc.id}...`);
      await DrawService.resolveDraw(doc.id).catch(err =>
        console.error(`Failed to resolve ${doc.id}:`, err)
      );
    }

    // 3. Payer les draws RESOLVED + PENDING
    const resolved = await db.collection('draws')
      .where('status', '==', 'RESOLVED')
      .where('payoutStatus', '==', 'PENDING')
      .get();
    for (const doc of resolved.docs) {
      console.log(`[Scheduler] Paying draw ${doc.id}...`);
      await PayoutService.distributePayouts(doc.id).catch(err =>
        console.error(`Failed to payout ${doc.id}:`, err)
      );
    }
  } catch (err) {
    console.error(`[Scheduler] Fatal error in draw cycle:`, err);
  }
};

/**
 * Cycle Flash toutes les minutes.
 * 1. Ferme les Flash OPEN expirés
 * 2. Résout les Flash CLOSED
 * 3. Paie les Flash RESOLVED + PENDING
 * 4. Lance les Flash automatiques selon la config
 */
export const runFlashCycle = async (): Promise<void> => {
  const nowIso = new Date().toISOString();
  const now = new Date();

  try {
    // 1. Fermer les Flash expirés
    const openFlashes = await db.collection('flash_draws')
      .where('status', '==', 'OPEN')
      .get();
    for (const doc of openFlashes.docs) {
      const data = doc.data() as FlashDraw;
      if (nowIso >= data.endTime) {
        console.log(`[Flash] Closing ${doc.id}...`);
        await FlashService.closeFlash(doc.id).catch(err =>
          console.error(`[Flash] Failed to close ${doc.id}:`, err)
        );
      }
    }

    // 2. Résoudre les Flash CLOSED
    const closedFlashes = await db.collection('flash_draws')
      .where('status', '==', 'CLOSED')
      .get();
    for (const doc of closedFlashes.docs) {
      if (doc.data().locked === true) continue;
      console.log(`[Flash] Resolving ${doc.id}...`);
      await FlashService.resolveFlash(doc.id).catch(err =>
        console.error(`[Flash] Failed to resolve ${doc.id}:`, err)
      );
    }

    // 3. Payer les Flash RESOLVED + PENDING
    const resolvedFlashes = await db.collection('flash_draws')
      .where('status', '==', 'RESOLVED')
      .where('payoutStatus', '==', 'PENDING')
      .get();
    for (const doc of resolvedFlashes.docs) {
      console.log(`[Flash] Paying ${doc.id}...`);
      await PayoutService.distributePayouts(doc.id).catch(err =>
        console.error(`[Flash] Failed to payout ${doc.id}:`, err)
      );
    }

    // 4. Lancer les Flash automatiques selon la config
    const config = await FlashService.getScheduleConfig();
    if (!config.enabled || !config.slots?.length) return;

    // Vérifier si un Flash est déjà actif
    const activeFlash = await FlashService.getActiveFlash();
    if (activeFlash) return; // Un Flash est déjà en cours

    const currentHour = now.getUTCHours();
    const currentMinute = now.getUTCMinutes();

    for (const slot of config.slots) {
      if (!slot.enabled) continue;

      // Vérifier si on est exactement sur l'heure de démarrage (à la minute près)
      if (slot.startHour === currentHour && slot.startMinute === currentMinute) {
        console.log(`[Flash] Auto-launching: ${slot.label}`);
        await FlashService.createFlash({
          label: slot.label,
          durationMinutes: slot.durationMinutes,
          multiplier: slot.multiplier,
          createdBy: 'system',
          autoSchedule: true,
        }).catch(err => console.error(`[Flash] Auto-launch failed:`, err));
        break; // Un seul Flash à la fois
      }
    }
  } catch (err) {
    console.error(`[Flash] Fatal error in flash cycle:`, err);
  }
};

/**
 * Démarrage du scheduler complet.
 */
export const startDrawScheduler = (): void => {
  // JOB A : Création quotidienne des draws normaux à 00:00
  cron.schedule('0 0 * * *', async () => {
    const today = getTodayDate();
    console.log(`[Scheduler] 00:00 — Creating daily draws for ${today}...`);
    try {
      await createDailyDraws(today);
    } catch (err) {
      console.error('[Scheduler] Error creating daily draws:', err);
    }
  }, { timezone: 'Africa/Lome' });

  // JOB B : Cycle draws normaux — toutes les minutes
  cron.schedule('* * * * *', async () => {
    await runMultiSlotCycle();
  }, { timezone: 'Africa/Lome' });

  // JOB C : Cycle Flash — toutes les minutes
  cron.schedule('* * * * *', async () => {
    await runFlashCycle();
  }, { timezone: 'Africa/Lome' });

  // BOOTSTRAP IDEMPOTENT
  const today = getTodayDate();
  drawsExistForDate(today)
    .then(exists => {
      if (exists) {
        console.log(`[Scheduler] Bootstrap: draws already exist for ${today}, skipping.`);
      } else {
        console.log(`[Scheduler] Bootstrap: creating draws for ${today}...`);
        return createDailyDraws(today);
      }
    })
    .catch(err => console.error('[Scheduler] Bootstrap failed:', err));

  console.log('[Scheduler] Multi-Slot + Flash Automation Started (Lome Timezone)');
};