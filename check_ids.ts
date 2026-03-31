import { db } from './src/config/firebase';

async function checkIds() {
  const betsSnapshot = await db.collection('bets').orderBy('createdAt', 'desc').limit(5).get();
  const bets = betsSnapshot.docs.map(d => ({ id: d.id, data: d.data() }));

  const drawsSnapshot = await db.collection('draws').limit(10).get();
  const drawIds = drawsSnapshot.docs.map(d => d.id);

  console.log("--- BETHISTORY CHECK ---");
  bets.forEach(bet => {
    console.log(`BetID: ${bet.id}, DrawID in Bet: "${bet.data.draw_id}"`);
    const match = drawIds.includes(bet.data.draw_id);
    console.log(`Draw exists in DB? ${match}`);
  });
  
  console.log("\n--- AVAILABLE DRAW IDS ---");
  console.log(drawIds);
}

checkIds().catch(console.error);
