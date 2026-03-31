import { db } from './src/config/firebase';

async function listTransactionUsers() {
  console.log('--- Listing Users with Bet Transactions ---');
  const snapshot = await db.collection('transactions').where('type', '==', 'bet').get();
  const userIds = new Set();
  
  snapshot.docs.forEach(doc => {
    userIds.add(doc.data().user_id);
  });
  
  console.log('User IDs in Transactions:', Array.from(userIds));
  console.log('Total bet transactions:', snapshot.docs.length);
}

listTransactionUsers().catch(console.error);
