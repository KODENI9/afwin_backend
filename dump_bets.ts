import { db } from './src/config/firebase';

async function dumpBets() {
  console.log("--- DUMPING RECENT BETS ---");
  const snapshot = await db.collection('bets').orderBy('createdAt', 'desc').limit(5).get();
  
  if (snapshot.empty) {
    console.log("No bets found.");
    return;
  }

  snapshot.docs.forEach(doc => {
    console.log(`ID: ${doc.id}`);
    console.log(JSON.stringify(doc.data(), null, 2));
    console.log("-------------------");
  });
}

dumpBets().catch(console.error);
