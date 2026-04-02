import { db } from './config/firebase';
import { Draw, Bet } from './types';

async function reproducePhantomRead() {
    console.log('--- REPRODUCTION Phantom Read ---');
    
    // 1. Créer un tirage de test
    const drawId = "TEST-RACE-" + Date.now();
    const drawRef = db.collection('draws').doc(drawId);
    await drawRef.set({
        status: 'OPEN',
        draw_date: '2026-04-01',
        slotId: 'S1',
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 60000).toISOString(),
        totalPool: 0,
        multiplier: 5,
        created_at: new Date().toISOString()
    });

    console.log(`Tirage ${drawId} créé (Status: OPEN).`);

    // 2. Lancer closeDraw (avec une transaction)
    console.log('Tentative de clôture du tirage...');
    
    // On lance la transaction en parallèle de l'insertion
    const results = await Promise.all([
        db.runTransaction(async (t) => {
            await t.get(drawRef);
            
            // ÉTAPE A : On prend le snapshot des paris
            console.log('[Transaction] Lecture du snapshot des paris...');
            const query = db.collection('bets').where('draw_id', '==', drawId);
            const snapshot = await t.get(query);
            
            // SIMULATION DE DÉLAI : On laisse du temps pour une insertion concurrente
            console.log('[Transaction] Attente artificielle de 2s...');
            await new Promise(r => setTimeout(r, 2000));

            const snapshotTotals: Record<string, number> = {};
            for (let i = 1; i <= 9; i++) snapshotTotals[i.toString()] = 0;
            
            let total = 0;
            snapshot.docs.forEach(doc => {
                const b = doc.data() as Bet;
                snapshotTotals[b.number.toString()] = (snapshotTotals[b.number.toString()] || 0) + b.amount;
                total += b.amount;
            });

            console.log('[Transaction] Mise à jour du tirage (CLOSED)...');
            t.update(drawRef, {
                status: 'CLOSED',
                snapshotTotals,
                totalPool: total,
                closedAt: new Date().toISOString()
            });
            
            return { snapshotTotals, total };
        }),
        
        // ÉTAPE B : On insère un pari PENDANT que la transaction ci-dessus est en cours
        (async () => {
            await new Promise(r => setTimeout(r, 500)); // Attendre que la transaction ait lu le snapshot
            console.log('[Concurrence] Insertion d\'un pari "Fantôme"...');
            const betRef = db.collection('bets').doc();
            await betRef.set({
                draw_id: drawId,
                user_id: 'phantom_user',
                number: 5,
                amount: 777,
                status: 'PENDING',
                createdAt: new Date().toISOString(),
                payoutAmount: 0
            });
            console.log('[Concurrence] Pari Fantôme inséré avec succès.');
        })()
    ]);

    const closeResult = results[0];
    console.log('--- RÉSULTAT ---');
    console.log(`Snapshot Totals (Chiffre 5): ${closeResult.snapshotTotals['5']} CFA`);

    // Vérifier la base réelle
    const realBetsSnapshot = await db.collection('bets').where('draw_id', '==', drawId).get();
    let realTotal = 0;
    realBetsSnapshot.docs.forEach(d => realTotal += d.data().amount);
    
    console.log(`Données Réelles en Base: ${realTotal} CFA (${realBetsSnapshot.size} paris)`);

    if (closeResult.total < realTotal) {
        console.log('🔴 BUG DÉMONTRÉ : Le pari inséré pendant la transaction a été MANQUÉ par le snapshot !');
        console.log('📍 CAUSE : Phantom Read dans les transactions Firestore sur collections.');
        console.log('📍 IMPACT : resolveDraw travaillera sur des données fausses.');
    } else {
        console.log('🟢 Aucun bug détecté cette fois (peut nécessiter plusieurs essais).');
    }
}

reproducePhantomRead().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
