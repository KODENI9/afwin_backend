import { db } from './config/firebase';
import { DrawService } from './services/draw.service';

async function testFix() {
    console.log('--- TESTING 2-PHASE DRAW CLOSURE ---');
    
    // 1. Create a test draw
    const drawId = "TEST-FIX-" + Date.now();
    const drawRef = db.collection('draws').doc(drawId);
    await drawRef.set({
        status: 'OPEN',
        draw_date: '2026-04-02',
        slotId: 'S1',
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 60000).toISOString(),
        totalPool: 0,
        multiplier: 5,
        created_at: new Date().toISOString()
    });

    console.log(`Draw ${drawId} created.`);

    // 2. Launch closure and a concurrent bet
    // This time we use a mock bet that simulates the real app by updating drawRef.
    const results = await Promise.all([
        (async () => {
             console.log('[Test] Starting closeDraw...');
             await DrawService.closeDraw(drawId);
             console.log('[Test] closeDraw finished.');
        })(),
        (async () => {
            await new Promise(r => setTimeout(r, 100)); // Delay to start during Phase 1
            console.log('[Test] Attempting "Late" Bet insertion...');
            
            try {
                await db.runTransaction(async (t) => {
                    const d = await t.get(drawRef);
                    if (d.data()?.status !== 'OPEN') {
                        throw new Error('STATUS_CLOSED_REJECTION');
                    }
                    
                    const betRef = db.collection('bets').doc();
                    t.set(betRef, {
                        draw_id: drawId,
                        user_id: 'test_user',
                        number: 5,
                        amount: 1000,
                        status: 'PENDING',
                        createdAt: new Date().toISOString(),
                        payoutAmount: 0
                    });
                    
                    t.update(drawRef, { totalPool: (d.data()?.totalPool || 0) + 1000 });
                });
                console.log('[Test] Late Bet committed successfully.');
            } catch (e: any) {
                console.log(`[Test] Late Bet rejected as expected: ${e.message}`);
            }
        })()
    ]);

    // 3. Verification
    const finalDraw = (await drawRef.get()).data();
    console.log('\n--- FINAL RESULTS ---');
    console.log(`Draw Status: ${finalDraw?.status}`);
    console.log(`Snapshot Pool: ${finalDraw?.totalPool} CFA`);
    
    const realBetsSnapshot = await db.collection('bets').where('draw_id', '==', drawId).get();
    let realTotal = 0;
    realBetsSnapshot.docs.forEach(d => realTotal += d.data().amount);
    
    console.log(`Real Bytes in DB: ${realTotal} CFA (${realBetsSnapshot.size} bets)`);

    if (finalDraw?.totalPool === realTotal) {
        console.log('✅ SUCCESS: System is consistent.');
        if (realTotal === 0) {
            console.log('📍 The late bet was correctly rejected.');
        } else {
            console.log('📍 The bet was correctly included in the snapshot (it committed before the gate closed).');
        }
    } else {
        console.log('🔴 FAILURE: Inconsistency detected!');
    }
}

testFix().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
