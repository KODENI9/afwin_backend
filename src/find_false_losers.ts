import { db } from './config/firebase';
import { Draw, Bet } from './types';

async function findFalseLosers() {
    console.log('--- SEARCHING FOR FALSE LOSERS ---');
    
    // 1. Get all resolved draws
    const drawsSnapshot = await db.collection('draws')
        .where('status', '==', 'RESOLVED')
        .get();

    for (const drawDoc of drawsSnapshot.docs) {
        const drawData = drawDoc.data() as Draw;
        const drawId = drawDoc.id;
        const winningNumber = drawData.winningNumber;

        if (winningNumber === undefined) continue;

        // 2. Search for bets in this draw marked as LOST but with the winning number
        const badBetsSnapshot = await db.collection('bets')
            .where('draw_id', '==', drawId)
            .where('number', '==', winningNumber)
            .where('status', '==', 'LOST')
            .get();

        if (!badBetsSnapshot.empty) {
            console.log(`\n🔴 FOUND ${badBetsSnapshot.size} FALSE LOSERS in Draw ${drawId}!`);
            console.log(`Winning Number was: ${winningNumber}`);
            
            for (const betDoc of badBetsSnapshot.docs) {
                const betData = betDoc.data();
                console.log(`- BetID: ${betDoc.id}, User: ${betData.user_id}, Bet Number: ${betData.number}, Type of Number: ${typeof betData.number}`);
            }
        }
        
        // 3. Optional: Search for bets marked as WON but with WRONG number
        const falseWinnersSnapshot = await db.collection('bets')
            .where('draw_id', '==', drawId)
            .where('status', '==', 'WON')
            .get();
            
        for (const betDoc of falseWinnersSnapshot.docs) {
            const betData = betDoc.data();
            if (Number(betData.number) !== Number(winningNumber)) {
                console.log(`\n🔴 FOUND FALSE WINNER in Draw ${drawId}!`);
                console.log(`Winning Number was: ${winningNumber}, Bet was: ${betData.number}`);
            }
        }
    }
    console.log('\n--- SEARCH COMPLETE ---');
}

findFalseLosers().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
