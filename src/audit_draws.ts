import { db } from './config/firebase';
import { Draw, Bet } from './types';

async function auditAllDraws() {
    console.log('--- AUDITING ALL RESOLVED DRAWS ---');
    
    // 1. Get all resolved draws
    const drawsSnapshot = await db.collection('draws')
        .where('status', '==', 'RESOLVED')
        .get();

    if (drawsSnapshot.empty) {
        console.log('No resolved draws found.');
        return;
    }

    console.log(`Found ${drawsSnapshot.size} draws to audit.\n`);

    let totalPhantomBets = 0;
    let problematicDraws = 0;

    for (const drawDoc of drawsSnapshot.docs) {
        const drawData = drawDoc.data() as any;
        const drawId = drawDoc.id;
        const snapshotTotals = drawData.snapshotTotals || {};
        const snapshotPool = Number(drawData.totalPool) || 0;
        const closedAt = drawData.closedAt;

        // 2. Calculate actual totals from bets collection
        const betsSnapshot = await db.collection('bets')
            .where('draw_id', '==', drawId)
            .get();

        let actualPool = 0;
        let phantomInThisDraw = 0;

        betsSnapshot.docs.forEach(doc => {
            const bet = doc.data() as Bet;
            const amt = Number(bet.amount);
            actualPool += amt;
        });

        if (Math.abs(snapshotPool - actualPool) > 1) { // Floating point safety
            problematicDraws++;
            console.log(`❌ ERROR: Inconsistency in Draw ${drawId}`);
            console.log(`   Snapshot Pool: ${snapshotPool} CFA`);
            console.log(`   Actual Pool:   ${actualPool} CFA`);
            console.log(`   Difference:    ${actualPool - snapshotPool} CFA`);

            // Detail which numbers are wrong
            const actualTotals: Record<number, number> = {};
            for (let i = 1; i <= 9; i++) actualTotals[i] = 0;
            
            betsSnapshot.docs.forEach(doc => {
                const bet = doc.data() as Bet;
                const num = Number(bet.number);
                if (num >= 1 && num <= 9) {
                    (actualTotals as any)[num] = ((actualTotals as any)[num] || 0) + Number(bet.amount);
                }
            });

            for (let i = 1; i <= 9; i++) {
                const snapVal = Number(snapshotTotals[i]) || 0;
                const actVal = Number(actualTotals[i]) || 0;
                if (snapVal !== actVal) {
                    const diff = actVal - snapVal;
                    console.log(`   - Number ${i}: Snap=${snapVal}, Actual=${actVal} (Diff: ${diff})`);
                    if (diff > 0) {
                        phantomInThisDraw++;
                        totalPhantomBets++;
                    }
                }
            }
            
            const winningNumber = drawData.winningNumber;
            const snapWinningTotal = winningNumber !== undefined ? (Number((snapshotTotals as any)[winningNumber]) || 0) : 0;
            const actualWinningTotal = winningNumber !== undefined ? (Number(actualTotals[winningNumber]) || 0) : 0;
            if (snapWinningTotal !== actualWinningTotal) {
                console.log(`   ⚠️ CRITICAL: Winning Number ${winningNumber} was impacted!`);
                console.log(`   User might have been marked as winner but paid wrong or safety-swapped incorrectly.`);
            }
            console.log('');
        }
    }

    console.log('--- AUDIT COMPLETE ---');
    console.log(`Total Draws Audited: ${drawsSnapshot.size}`);
    console.log(`Problematic Draws:   ${problematicDraws}`);
    console.log(`Total Phantom Bets:  ${totalPhantomBets}`);
}

auditAllDraws().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
