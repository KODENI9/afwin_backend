import { db } from './src/config/firebase';

async function checkBets() {
  console.log('--- Checking Last 5 Bets in Collection ---');
  const snapshot = await db.collection('bets').limit(5).get();
  if (snapshot.empty) {
    console.log('No bets found in the entire collection!');
    return;
  }
  
  snapshot.docs.forEach(doc => {
    console.log(`ID: ${doc.id}`);
    console.log(`User ID: ${doc.data().user_id}`);
    console.log(`Draw ID: ${doc.data().draw_id}`);
    console.log(`Amount: ${doc.data().amount}`);
    console.log(`Created At: ${doc.data().createdAt}`);
    console.log('---');
  });
}

checkBets().catch(console.error);
