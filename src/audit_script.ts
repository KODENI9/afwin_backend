import { db } from './config/firebase';
import { Draw, Bet } from './types';

async function auditDraws() {
    console.log('--- AUDIT DES TIRAGES RÉCENTS ---');
    
    const drawsSnapshot = await db.collection('draws')
        .where('__name__', '==', '2026-03-30-S2')
        .get();

    if (drawsSnapshot.empty) {
        console.log('Aucun tirage résolu trouvé.');
        return;
    }

    const draws = drawsSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as any));
    // Tri en mémoire par date de résolution décroissante
    draws.sort((a: any, b: any) => new Date(b.resolvedAt || 0).getTime() - new Date(a.resolvedAt || 0).getTime());

    for (const drawData of draws) {
        const drawId = drawData.id;
        const snapshotTotals = drawData.snapshotTotals || {};
        const snapshotPool = Number(drawData.totalPool) || 0;
        const closedAt = drawData.closedAt;

        console.log(`\n🔍 Tirage: ${drawId} (Clôturé à: ${closedAt})`);
        
        // Calculer les totaux réels depuis la collection bets
        const betsSnapshot = await db.collection('bets')
            .where('draw_id', '==', drawId)
            .get();

        const actualTotals: Record<number, number> = {};
        for (let i = 1; i <= 9; i++) actualTotals[i] = 0;
        
        let actualPool = 0;
        let lateBetsCount = 0;

        betsSnapshot.docs.forEach(doc => {
            const bet = doc.data() as Bet;
            const num = Number(bet.number);
            const amt = Number(bet.amount);
            const createdAt = bet.createdAt;

            if (num >= 1 && num <= 9 && amt > 0) {
                actualTotals[num] = (actualTotals[num] || 0) + amt;
                actualPool += amt;
            }

            if (closedAt && createdAt && new Date(createdAt).getTime() > new Date(closedAt).getTime()) {
                lateBetsCount++;
                console.log(`⚠️ Pari TARDIF détecté: BetID: ${doc.id}, User: ${bet.user_id}, Date: ${createdAt}`);
            }
        });

        // Comparaison
        let isMatch = true;
        for (let i = 1; i <= 9; i++) {
            const snapVal = Number(snapshotTotals[i]) || 0;
            const actVal = Number(actualTotals[i]) || 0;
            if (snapVal !== actVal) {
                isMatch = false;
                console.log(`❌ INCOHÉRENCE sur le chiffre ${i}: Snapshot=${snapVal}, Réel=${actVal}`);
            }
        }

        if (Number(snapshotPool) !== Number(actualPool)) {
            isMatch = false;
            console.log(`❌ INCOHÉRENCE POOL: Snapshot=${snapshotPool}, Réel=${actualPool}`);
        }

        if (isMatch) {
            console.log('✅ Cohérence parfaite entre Snapshot et Bets.');
        } else {
            console.log('🔴 BUG DE COHÉRENCE IDENTIFIÉ !');
        }
        
        console.log(`📋 Statistiques: ${betsSnapshot.size} paris trouvés, ${lateBetsCount} après clôture.`);
    }
}

auditDraws().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
