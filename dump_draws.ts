import { db } from './src/config/firebase';

async function dumpDraws() {
  console.log("--- DUMPING RECENT DRAWS ---");
  const snapshot = await db.collection('draws').orderBy('startTime', 'desc').limit(5).get();
  
  if (snapshot.empty) {
    console.log("No draws found.");
    return;
  }

  snapshot.docs.forEach(doc => {
    console.log(`ID: ${doc.id}`);
    console.log(JSON.stringify(doc.data(), null, 2));
    console.log("-------------------");
  });
}

dumpDraws().catch(console.error);
