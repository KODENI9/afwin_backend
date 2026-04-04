import { db } from '../config/firebase';
import { Draw, Bet, Transaction, Notification } from '../types';
import { AuditAction, logAudit } from './audit.service';

export class PayoutService {

  /**
   * Distributes payouts for a resolved draw.
   *
   * FIXES APPLIED:
   * 1. [BUG FIX] Query `.where()` remplacé par DocumentReference fixe (idempotencyKey = doc ID)
   *    → Firestore n'autorise pas les queries dans une transaction.
   * 2. [BUG FIX] totalPaid calculé en lecture seule AVANT la boucle de transactions
   *    → Évite la race condition en cas de multi-instance ou crash/reprise.
   * 3. [BUG FIX] Suppression du champ ambigu `totalPayoutDistributed`
   *    → On utilise uniquement `totalPayout` de manière cohérente.
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

    // Marquer comme en cours (sans totalPayoutDistributed ambigu)
    await drawRef.update({
      payoutStatus: 'PROCESSING',
      updated_at: new Date().toISOString()
    });

    const { winningNumber, realMultiplier, multiplier } = drawData;
    const effectiveMultiplier = realMultiplier !== undefined ? realMultiplier : (multiplier || 5);

    // ─────────────────────────────────────────────────────────────
    // LECTURE UNIQUE de tous les bets
    // ─────────────────────────────────────────────────────────────
    const snapshot = await db.collection('bets')
      .where('draw_id', '==', drawId)
      .get();

    console.log(`Processing ${snapshot.size} bets for draw ${drawId}...`);

    // ─────────────────────────────────────────────────────────────
    // FIX 2 : Précalcul du totalPaid en lecture seule
    // On parcourt les bets UNE FOIS avant les transactions pour avoir
    // un total fiable, indépendant de l'ordre ou des retries.
    // ─────────────────────────────────────────────────────────────
    let totalPaid = 0;
    for (const betDoc of snapshot.docs) {
      const betData = betDoc.data() as Bet;

      const isLate = betData.createdAt && drawData.closedAt &&
        (new Date(betData.createdAt).getTime() > new Date(drawData.closedAt).getTime());

      if (isLate) continue;

      const isWinner = Number(betData.number) === Number(winningNumber);
      if (isWinner) {
        totalPaid += Math.floor(betData.amount * effectiveMultiplier);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // BOUCLE PRINCIPALE : traitement de chaque bet
    // ─────────────────────────────────────────────────────────────
    for (const betDoc of snapshot.docs) {
      const betId = betDoc.id;
      const betData = betDoc.data() as Bet;
      const userId = betData.user_id;

      // Détection des paris fantômes (postérieurs à la fermeture)
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

      // FIX 1 : idempotencyKey utilisé comme ID de document fixe
      // → permet un t.get(DocumentReference) valide dans une transaction
      const idempotencyKey = `PAYOUT_${drawId}_${betId}`;
      const txRef = db.collection('transactions').doc(idempotencyKey);

      const isWinner = Number(betData.number) === Number(winningNumber);
      const payoutAmount = isWinner ? Math.floor(betData.amount * effectiveMultiplier) : 0;
      const betStatus: 'WON' | 'LOST' = isWinner ? 'WON' : 'LOST';

      await db.runTransaction(async (t) => {
        // FIX 1 : lecture par DocumentReference (autorisé en transaction)
        const existingTx = await t.get(txRef);

        // Mise à jour du statut du bet (toujours, même si déjà payé)
        t.update(betDoc.ref, {
          status: betStatus,
          payoutAmount,
          resolvedAt: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

        // Anti-double-paiement : si la transaction existe déjà, on s'arrête
        if (existingTx.exists) return;

        if (payoutAmount > 0) {
          const profileRef = db.collection('profiles').doc(userId);
          const profileDoc = await t.get(profileRef);

          const currentBalance = profileDoc.data()?.balance || 0;
          t.update(profileRef, { balance: currentBalance + payoutAmount });

          // FIX 1 : on écrit sur txRef (ID fixe = idempotencyKey)
          t.set(txRef, {
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
        }
      });
    }

    // FIX 3 : un seul champ `totalPayout`, cohérent avec le reste du code
    const profit = (drawData.totalPool || 0) - totalPaid;

    await drawRef.update({
      payoutStatus: 'COMPLETED',
      totalPayout: totalPaid,   // seul champ utilisé, plus d'ambiguïté
      profit,
      updated_at: new Date().toISOString()
    });

    console.log(`✅ Payout terminé pour ${drawId}. Total payé: ${totalPaid} CFA. Profit: ${profit} CFA.`);
  }
}