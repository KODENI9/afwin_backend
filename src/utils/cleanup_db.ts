import { db } from '../config/firebase';

const COLLECTIONS_TO_WIPE = [
  'profiles',
  'transactions',
  'draws',
  'bets',
  'notifications'
];

async function deleteCollection(collectionPath: string, batchSize: number = 500) {
  const collectionRef = db.collection(collectionPath);
  const query = collectionRef.orderBy('__name__').limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(query, resolve).catch(reject);
  });
}

async function deleteQueryBatch(query: FirebaseFirestore.Query, resolve: any) {
  const snapshot = await query.get();

  const batchSize = snapshot.size;
  if (batchSize === 0) {
    resolve();
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();

  process.nextTick(() => {
    deleteQueryBatch(query, resolve);
  });
}

async function cleanup() {
  console.log('--- STARTING DATABASE CLEANUP ---');
  
  for (const collection of COLLECTIONS_TO_WIPE) {
    console.log(`Clearing collection: ${collection}...`);
    try {
      await deleteCollection(collection);
      console.log(`✅ ${collection} cleared.`);
    } catch (error) {
      console.error(`❌ Error clearing ${collection}:`, error);
    }
  }

  console.log('--- CLEANUP COMPLETE ---');
  process.exit(0);
}

cleanup();
