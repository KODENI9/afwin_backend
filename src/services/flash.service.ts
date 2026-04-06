import { db } from '../config/firebase';
import { FlashDraw, FlashScheduleConfig } from '../types';
import { DrawService } from './draw.service';
import { PayoutService } from './payout.service';
import { AuditAction, logAudit } from './audit.service';
import crypto from 'crypto';

/**
 * ═══════════════════════════════════════════════════════
 *  AF-WIN — FLASH DRAW SERVICE
 * ═══════════════════════════════════════════════════════
 *
 * Les Flash Draws sont des mini-tirages courts (2-10 min)
 * stockés dans la collection `flash_draws`.
 *
 * Ils réutilisent la même logique que les draws normaux :
 * - closeDraw adapté pour flash_draws
 * - resolveWinningNumber de DrawService (partagé)
 * - distributePayouts de PayoutService (partagé, draw_id = flash_id)
 */
export class FlashService {

  /**
   * Crée un nouveau Flash Draw.
   * Appelé manuellement par l'admin ou automatiquement par le scheduler.
   */
  static async createFlash(params: {
    label: string;
    durationMinutes: number;
    multiplier: number;
    createdBy: string;
    autoSchedule?: boolean;
  }): Promise<string> {
    const { label, durationMinutes, multiplier, createdBy, autoSchedule = false } = params;

    if (durationMinutes < 2 || durationMinutes > 60) {
      throw new Error('Durée Flash invalide (2-60 minutes).');
    }
    if (multiplier < 2 || multiplier > 20) {
      throw new Error('Multiplicateur Flash invalide (2-20x).');
    }

    const now = new Date();
    const endTime = new Date(now.getTime() + durationMinutes * 60 * 1000);

    const flashData: Omit<FlashDraw, 'id'> = {
      type: 'flash',
      label,
      durationMinutes,
      startTime: now.toISOString(),
      endTime: endTime.toISOString(),
      status: 'OPEN',
      multiplier,
      totalPool: 0,
      locked: false,
      createdBy,
      createdAt: now.toISOString(),
      autoSchedule,
    };

    const docRef = await db.collection('flash_draws').add(flashData);

    // Notification globale aux users
    const usersSnapshot = await db.collection('profiles').get();
    const batch = db.batch();
    usersSnapshot.docs.forEach(userDoc => {
      const notifRef = db.collection('notifications').doc();
      batch.set(notifRef, {
        user_id: userDoc.id,
        title: `⚡ ${label} — Tirage Flash !`,
        message: `Un tirage Flash de ${durationMinutes} min vient de démarrer ! Multiplicateur x${multiplier}. Misez maintenant !`,
        type: 'info',
        read: false,
        created_at: now.toISOString(),
      });
    });
    await batch.commit();

    await logAudit(AuditAction.CLOSE_DRAW, {
      action: 'FLASH_CREATED',
      flashId: docRef.id,
      label,
      durationMinutes,
      multiplier,
      createdBy,
      autoSchedule,
    });

    console.log(`[Flash] Created: ${docRef.id} — ${label} (${durationMinutes}min x${multiplier})`);
    return docRef.id;
  }

  /**
   * Ferme un Flash Draw (OPEN → CLOSED) et prend le snapshot des bets.
   * Adapté de DrawService.closeDraw() pour flash_draws.
   */
  static async closeFlash(flashId: string): Promise<void> {
    const flashRef = db.collection('flash_draws').doc(flashId);

    // Phase 1 : Lock atomique
    await db.runTransaction(async (t) => {
      const doc = await t.get(flashRef);
      if (!doc.exists) throw new Error(`Flash ${flashId} not found`);
      const data = doc.data() as FlashDraw;
      if (data.status !== 'OPEN') {
        throw new Error(`Flash ${flashId} is not OPEN (status: ${data.status})`);
      }
      t.update(flashRef, {
        status: 'CLOSED',
        closedAt: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    });

    console.log(`[Flash] Phase 1 Complete: ${flashId} CLOSED.`);

    // Phase 2 : Snapshot des bets HORS transaction
    const betsSnapshot = await db.collection('bets')
      .where('draw_id', '==', flashId)
      .get();

    const snapshotTotals: Record<number, number> = {};
    for (let i = 1; i <= 9; i++) snapshotTotals[i] = 0;
    let totalPool = 0;

    betsSnapshot.docs.forEach(doc => {
      const bet = doc.data();
      const num = Number(bet.number);
      const amt = Number(bet.amount);
      if (isNaN(num) || num < 1 || num > 9) return;
      if (isNaN(amt) || amt <= 0) return;
      snapshotTotals[num] = (snapshotTotals[num] || 0) + amt;
      totalPool += amt;
    });

    const timestamp = new Date().toISOString();
    const hashContent = JSON.stringify({ snapshotTotals, totalPool, flashId, timestamp });
    const snapshotHash = crypto.createHash('sha256').update(hashContent).digest('hex');

    // Écriture atomique du snapshot
    await db.runTransaction(async (t) => {
      const doc = await t.get(flashRef);
      const data = doc.data() as FlashDraw;
      if (data.snapshotHash) {
        console.log(`[Flash] Snapshot already done for ${flashId}, skipping.`);
        return;
      }
      t.update(flashRef, {
        totalPool,
        snapshotTotals,
        snapshotHash,
        updated_at: timestamp,
      });
    });

    console.log(`[Flash] Phase 2 Complete: ${flashId} snapshot done. Pool: ${totalPool} CFA`);
  }

  /**
   * Résout un Flash Draw (CLOSED → RESOLVED).
   * Réutilise resolveWinningNumber de DrawService.
   */
  static async resolveFlash(flashId: string): Promise<void> {
    let auditData: any = null;

    await db.runTransaction(async (t) => {
      const flashRef = db.collection('flash_draws').doc(flashId);
      const doc = await t.get(flashRef);
      if (!doc.exists) throw new Error(`Flash ${flashId} not found`);
      const data = doc.data() as FlashDraw;

      if (data.status !== 'CLOSED') {
        throw new Error(`Flash must be CLOSED to resolve. Status: ${data.status}`);
      }
      if (data.locked) {
        console.log(`[Flash] ${flashId} already locked, skipping.`);
        return;
      }
      if (!data.snapshotTotals || !data.snapshotHash) {
        throw new Error(`Missing snapshot data for Flash ${flashId}`);
      }

      // Réutiliser l'algo déterministe de DrawService
      const { winner, zeros, workingSet, minTotal, candidates, hashUsed } =
        DrawService.resolveWinningNumber(data.snapshotTotals, data.snapshotHash);

      const totalPool = data.totalPool || 0;
      const displayMultiplier = data.multiplier || 5;
      const MAX_MULTIPLIER = 20;

      let realMultiplier = Math.min(displayMultiplier, MAX_MULTIPLIER);
      let totalWinnerBets = Number(data.snapshotTotals[winner]) || 0;
      let totalPayout = totalWinnerBets * realMultiplier;
      let safetyTriggered = false;
      let fallbackUsed: string | null = null;
      let finalWinner = winner;

      if (totalPayout > totalPool) {
        safetyTriggered = true;
        if (zeros.length === 1) {
          finalWinner = zeros[0]!;
          realMultiplier = 0;
          totalWinnerBets = 0;
          totalPayout = 0;
          fallbackUsed = 'ZERO_SWAP';
        } else {
          realMultiplier = totalWinnerBets > 0 ? totalPool / totalWinnerBets : 0;
          realMultiplier = Math.min(realMultiplier, MAX_MULTIPLIER);
          totalPayout = totalWinnerBets * realMultiplier;
          fallbackUsed = 'MULTIPLIER_ADJUST';
        }
      }

      if (totalWinnerBets === 0) {
        realMultiplier = 0;
        totalPayout = 0;
      }

      if (totalWinnerBets * realMultiplier > totalPool) {
        throw new Error(`CRITICAL: Flash payout (${totalWinnerBets * realMultiplier}) > pool (${totalPool})`);
      }

      t.update(flashRef, {
        status: 'RESOLVED',
        locked: true,
        payoutStatus: 'PENDING',
        winningNumber: finalWinner,
        realMultiplier,
        resolvedAt: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      auditData = {
        flashId,
        winner: finalWinner,
        totalPool,
        realMultiplier,
        safetyTriggered,
        fallbackUsed,
        timestamp: new Date().toISOString(),
      };
    });

    if (auditData) {
      await logAudit(AuditAction.RESOLVE_DRAW, { ...auditData, action: 'FLASH_RESOLVED' });
    }

    console.log(`[Flash] Resolved: ${flashId}`);
  }

  /**
   * Récupère le Flash Draw actif (status OPEN), s'il existe.
   */
  static async getActiveFlash(): Promise<(FlashDraw & { id: string }) | null> {
    const snapshot = await db.collection('flash_draws')
      .where('status', '==', 'OPEN')
      .orderBy('startTime', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    const doc = snapshot.docs[0]!;
    return { id: doc.id, ...(doc.data() as FlashDraw) };
  }

  /**
   * Récupère la config des plages horaires Flash.
   */
  static async getScheduleConfig(): Promise<FlashScheduleConfig> {
    const doc = await db.collection('settings').doc('flash_config').get();
    if (!doc.exists) {
      return { enabled: false, slots: [] };
    }
    return doc.data() as FlashScheduleConfig;
  }

  /**
   * Sauvegarde la config des plages horaires Flash.
   */
  static async saveScheduleConfig(config: FlashScheduleConfig): Promise<void> {
    await db.collection('settings').doc('flash_config').set(config, { merge: true });
  }
}