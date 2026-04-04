/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║           SCRIPT DE RESET PRODUCTION — AF-WIN            ║
 * ║                  EXÉCUTION UNIQUE                         ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  Collections vidées :                                     ║
 * ║    draws, bets, transactions, audit_logs,                 ║
 * ║    notifications, idempotency_keys                        ║
 * ║                                                           ║
 * ║  Profils : uniquement balance → 0                         ║
 * ║  Users / Auth : NON TOUCHÉS                               ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * USAGE :
 *   1. Place ce fichier à la racine de ton projet backend
 *   2. npx ts-node reset-prod.ts
 *
 * PRÉ-REQUIS :
 *   - GOOGLE_APPLICATION_CREDENTIALS défini dans l'env
 *   - ou serviceAccountKey.json présent à la racine
 */

import * as admin from 'firebase-admin';
import * as readline from 'readline';

// ─── Init Firebase Admin ───────────────────────────────────────
// Adapte le chemin si ton serviceAccountKey est ailleurs
try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} catch {
  // Fallback : variable d'environnement
  admin.initializeApp();
}

const db = admin.firestore();

// ─── Configuration ─────────────────────────────────────────────
const COLLECTIONS_TO_DELETE = [
  'draws',
  'bets',
  'transactions',
  'audit_logs',
  'notifications',
  'idempotency_keys',
];

const BATCH_SIZE = 400; // Firestore limite à 500 ops par batch, on reste à 400 pour sécurité

// ─── Utilitaires ───────────────────────────────────────────────

/**
 * Supprime tous les documents d'une collection par chunks de BATCH_SIZE.
 * Gère les grandes collections (10k+ docs) sans exploser la mémoire.
 */
async function deleteCollection(collectionName: string): Promise<number> {
  let totalDeleted = 0;

  console.log(`\n  [${collectionName}] Suppression en cours...`);

  while (true) {
    const snapshot = await db.collection(collectionName).limit(BATCH_SIZE).get();

    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    totalDeleted += snapshot.size;
    process.stdout.write(`\r  [${collectionName}] ${totalDeleted} documents supprimés...`);
  }

  console.log(`\r  [${collectionName}] DONE — ${totalDeleted} documents supprimés.   `);
  return totalDeleted;
}

/**
 * Remet balance = 0 sur tous les profils utilisateurs.
 * Ne touche aucun autre champ.
 */
async function resetAllBalances(): Promise<number> {
  let totalUpdated = 0;
  let lastDoc: admin.firestore.QueryDocumentSnapshot | null = null;

  console.log(`\n  [profiles] Remise à zéro des balances...`);

  while (true) {
    let query = db.collection('profiles').limit(BATCH_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snapshot = await query.get();
    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.update(doc.ref, {
        balance: 0,
        updated_at: new Date().toISOString(),
      });
    });
    await batch.commit();

    totalUpdated += snapshot.size;
    lastDoc = snapshot.docs[snapshot.docs.length - 1]!;
    process.stdout.write(`\r  [profiles] ${totalUpdated} balances remises à 0...`);
  }

  console.log(`\r  [profiles] DONE — ${totalUpdated} balances remises à 0.   `);
  return totalUpdated;
}

/**
 * Demande une confirmation explicite dans le terminal.
 * Le script s'arrête si la réponse n'est pas exactement "RESET".
 */
function askConfirmation(): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║              ATTENTION — DONNÉES DE PRODUCTION            ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Collections qui seront VIDÉES DÉFINITIVEMENT :           ║');
    COLLECTIONS_TO_DELETE.forEach(c => {
      console.log(`║    - ${c.padEnd(52)}║`);
    });
    console.log('║                                                            ║');
    console.log('║  profiles : balance → 0 (rien d\'autre)                   ║');
    console.log('║  users / auth : NON TOUCHÉS                               ║');
    console.log('╚══════════════════════════════════════════════════════════╝');

    rl.question('\n  Tape RESET pour confirmer : ', (answer) => {
      rl.close();
      if (answer.trim() === 'RESET') {
        resolve();
      } else {
        reject(new Error('Confirmation refusée. Aucune donnée modifiée.'));
      }
    });
  });
}

// ─── Script principal ──────────────────────────────────────────
async function main(): Promise<void> {
  console.log('\n AF-WIN — Script de reset production\n');

  // Étape 0 : confirmation obligatoire
  await askConfirmation();

  console.log('\n  Démarrage du reset...\n');
  const startTime = Date.now();

  // Étape 1 : suppression des collections
  const stats: Record<string, number> = {};
  for (const col of COLLECTIONS_TO_DELETE) {
    stats[col] = await deleteCollection(col);
  }

  // Étape 2 : remise à zéro des balances
  stats['profiles (balance)'] = await resetAllBalances();

  // Étape 3 : rapport final
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                   RESET TERMINÉ                           ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  Object.entries(stats).forEach(([col, count]) => {
    const line = `  ${col} : ${count} docs traités`;
    console.log(`║ ${line.padEnd(58)}║`);
  });
  console.log(`║                                                            ║`);
  console.log(`║  Durée totale : ${elapsed}s`.padEnd(61) + '║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\n  Tu peux maintenant ajouter les balances utilisateur 1 à 1.\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\n  ERREUR FATALE :', err.message);
  process.exit(1);
});