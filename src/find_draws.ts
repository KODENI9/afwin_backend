import { db } from './config/firebase';

async function findDrawsWithBets() {
    console.log('--- FINDING DRAWS WITH BETS ---');
    
    const drawsSnapshot = await db.collection('draws')
        .where('totalPool', '>', 0)
        .limit(20)
        .get();

    if (drawsSnapshot.empty) {
        console.log('Aucun tirage avec des mises trouvé.');
        return;
    }

    for (const drawDoc of drawsSnapshot.docs) {
        const data = drawDoc.data();
        console.log(`Tirage: ${drawDoc.id}, Pool: ${data.totalPool}, Status: ${data.status}`);
    }
}

findDrawsWithBets().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
