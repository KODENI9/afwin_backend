import { db } from './src/config/firebase';

async function checkUserIds() {
  const betsSnapshot = await db.collection('bets').orderBy('createdAt', 'desc').get();
  
  console.log(`Found ${betsSnapshot.size} total bets.`);
  
  if (betsSnapshot.size > 0) {
    const firstBet = betsSnapshot.docs[0].data();
    console.log("FIRST BET DATA:");
    console.log(JSON.stringify(firstBet, null, 2));
    
    const secondBet = betsSnapshot.docs[1]?.data();
    if (secondBet) {
       console.log("SECOND BET DATA:");
       console.log(JSON.stringify(secondBet, null, 2));
    }
  }
}

checkUserIds().catch(console.error);
