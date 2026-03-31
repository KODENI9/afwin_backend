import { db } from './src/config/firebase';

async function checkIndex() {
  const userId = "test_user_id"; // Replace with a real one if known
  console.log("Testing query performance and index...");
  try {
    const start = Date.now();
    const snapshot = await db.collection('bets')
      .where('user_id', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const end = Date.now();
    console.log(`Query successful in ${end - start}ms. Result count: ${snapshot.size}`);
  } catch (err: any) {
    if (err.message.includes('FAILED_PRECONDITION')) {
      console.error("INDEX MISSING! Copy this URL to create it:");
      console.error(err.message.split('at ')[1]);
    } else {
      console.error("Query failed:", err.message);
    }
  }
}

checkIndex().catch(console.error);
