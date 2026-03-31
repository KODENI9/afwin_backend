import { db } from './src/config/firebase';

async function listBetUsers() {
  console.log('--- Listing Unique User IDs in Bets Collection ---');
  const snapshot = await db.collection('bets').limit(100).get();
  const userIds = new Set();
  
  snapshot.docs.forEach(doc => {
    userIds.add(doc.data().user_id);
  });
  
  console.log('User IDs found:', Array.from(userIds));
  console.log('Total bets inspected:', snapshot.docs.length);
}

listBetUsers().catch(console.error);
