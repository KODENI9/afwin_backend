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
 *
 * FIX APPLIED:
 * [BUG FIX] Bootstrap idempotent : createDailyDraws() n'est appelé au démarrage
 *   que si aucun draw n'existe déjà pour aujourd'hui.
 *   → Évite la création de draws en double lors d'un redémarrage serveur en cours de journée.
 */

const getTodayDate = () => new Date().toISOString().substring(0, 10);

/**
 * Vérifie si des draws existent déjà pour une date donnée.
 * Utilisé pour rendre le bootstrap idempotent.
 */
const drawsExistForDate = async (date: string): Promise<boolean> => {
  const snapshot = await db.collection('draws')
    .where('date', '==', date)
    .limit(1)
    .get();
  return !snapshot.empty;
};

/**
 * Main Status Transition Logic (EVERY MINUTE)
 * 1. CLOSE draws where now >= endTime
 * 2. RESOLVE draws where status === 'CLOSED'
 * 3. DISTRIBUTE payouts where status === 'RESOLVED' and payoutStatus === 'PENDING'
 */
export const runMultiSlotCycle = async (): Promise<void> => {
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    // 1. Fermer les draws OPEN expirés
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

    // 2. Résoudre les draws CLOSED
    // Note : on ne filtre pas sur `locked` ici car Firestore requiert un index
    // composite pour les inégalités multi-champs. Le check est géré dans resolveDraw().
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

    // 3. Distribuer les gains (RESOLVED + payoutStatus === 'PENDING')
    // Ce filtre fonctionne maintenant car resolveDraw() initialise payoutStatus à 'PENDING'.
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
  // --- JOB A: CRÉATION QUOTIDIENNE à 00:00 ---
  cron.schedule('0 0 * * *', async () => {
    const today = getTodayDate();
    console.log(`[Scheduler] 00:00 — Generating daily time slots for ${today}...`);
    try {
      await createDailyDraws(today);
    } catch (err) {
      console.error('[Scheduler] Error in multi-slot creation:', err);
    }
  }, { timezone: 'Africa/Lome' });

  // --- JOB B: AUTOMATION PAR MINUTE ---
  cron.schedule('* * * * *', async () => {
    console.log('[Scheduler] Checking for draw transitions...');
    await runMultiSlotCycle();
  }, { timezone: 'Africa/Lome' });

  // FIX 4 : BOOTSTRAP IDEMPOTENT
  // On vérifie si les draws du jour existent déjà AVANT de les créer,
  // pour éviter les doublons lors d'un redémarrage serveur en cours de journée.
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