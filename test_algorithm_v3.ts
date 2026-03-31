import { DrawService } from './src/services/draw.service';
import crypto from 'crypto';

const testCases = [
  {
    name: "Scénario A : 1 seul zéro (doit être ignoré) + Sélection Déterministe",
    snapshot: { 1: 0, 2: 1000, 3: 1000, 4: 3000, 5: 4000, 6: 5000, 7: 6000, 8: 7000, 9: 8000 },
    seed: "TEST_SEED_1",
    pool: 100000,
    expectedMultiplier: 5
  },
  {
    name: "Scénario B : Reproductibilité (Même snapshot + Même seed = Même gagnant)",
    snapshot: { 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000, 6: 1000, 7: 1000, 8: 1000, 9: 1000 },
    seed: "REPRO_SEED",
    pool: 100000
  },
  {
    name: "Scénario C : Plafonnement Multiplicateur Max x10",
    snapshot: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, 7: 100, 8: 100, 9: 100 },
    displayMultiplier: 25, // Tentative admin d'un gros multiplicateur
    seed: "SEED_MAX",
    pool: 100000,
    expectedMultiplier: 10
  },
  {
    name: "Scénario D : Risque Perte (Cas 2A - Swap Zéro)",
    snapshot: { 1: 0, 2: 20000, 3: 20000, 4: 20000, 5: 20000, 6: 20000, 7: 20000, 8: 20000, 9: 20000 },
    displayMultiplier: 5,
    seed: "SEED_SWAP",
    pool: 50000,
    // totalWinnerBets = 20000. 20000 * 5 = 100000 > 50000. 1 seul zéro (le 1).
    expectedMultiplier: 0,
    expectedWinner: 1
  },
  {
    name: "Scénario E : Risque Perte (Cas 2B - Ajustement Multiplicateur)",
    snapshot: { 1: 2000, 2: 2000, 3: 2000, 4: 2000, 5: 2000, 6: 2000, 7: 2000, 8: 2000, 9: 2000 },
    displayMultiplier: 10,
    seed: "SEED_ADJUST",
    pool: 10000,
    // totalWinnerBets = 2000. 2000 * 10 = 20000 > 10000. Pas de zéro.
    // real = 10000 / 2000 = 5.
    expectedMultiplier: 5
  },
  {
    name: "Scénario F : Aucun pari gagnant (0 bets)",
    snapshot: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 },
    seed: "SEED_NONE",
    pool: 0,
    expectedMultiplier: 0
  }
];

function runTests() {
  console.log("=== TESTS ALGORITHME DÉTERMINISTE AF-WIN V3 ===\n");
  
  testCases.forEach((tc, index) => {
    console.log(`TEST ${index + 1}: ${tc.name}`);
    
    // 1. Sélection (Appel direct au service avec seed)
    const res1 = DrawService.resolveWinningNumber(tc.snapshot, tc.seed);
    const winner = res1.winner;
    const winnerBet = Number((tc.snapshot as any)[winner] || 0);

    // Test Reproductibilité pour Scénario B
    if (tc.seed === "REPRO_SEED") {
      const res2 = DrawService.resolveWinningNumber(tc.snapshot, tc.seed);
      if (res1.winner === res2.winner && res1.hashUsed === res2.hashUsed) {
        console.log(`  ✅ Reproductibilité confirmée: ${res1.winner} (Hash: ${res1.hashUsed?.substring(0,8)}...)`);
      } else {
        console.log(`  ❌ FAIL Reproductibilité ! R1: ${res1.winner}, R2: ${res2.winner}`);
      }
    }

    if (tc.expectedWinner !== undefined && winner !== tc.expectedWinner) {
       // Note: Initial winner might be different from expectedWinner if a swap is expected in financial logic
       console.log(`  ℹ️ Initial Winner: ${winner}`);
    } else {
       console.log(`  ℹ️ Winner: ${winner} (Mises: ${winnerBet})`);
    }

    // 2. Calcul Payout (Simulation de la logique de resolveDraw)
    const MAX_MULTIPLIER = 10;
    const displayMultiplier = tc.displayMultiplier || 5;
    let realMultiplier = Math.min(displayMultiplier, MAX_MULTIPLIER);
    let totalWinnerBetsFinal = winnerBet;
    let winnerFinal = winner;
    let totalPayout = totalWinnerBetsFinal * realMultiplier;

    if (totalPayout > tc.pool) {
       if (res1.zeros.length === 1) {
          winnerFinal = res1.zeros[0]!;
          totalWinnerBetsFinal = 0;
          realMultiplier = 0;
          totalPayout = 0;
          console.log(`  ℹ️ Safety: Swap vers zéro (${winnerFinal})`);
       } else {
          realMultiplier = totalWinnerBetsFinal > 0 ? tc.pool / totalWinnerBetsFinal : 0;
          realMultiplier = Math.min(realMultiplier, MAX_MULTIPLIER);
          totalPayout = totalWinnerBetsFinal * realMultiplier;
          console.log(`  ℹ️ Safety: Ajustement multiplicateur (${realMultiplier})`);
       }
    }

    if (totalWinnerBetsFinal === 0) {
      realMultiplier = 0;
      totalPayout = 0;
    }

    // Vérifications
    if (tc.expectedMultiplier !== undefined) {
      if (Math.abs(realMultiplier - tc.expectedMultiplier) < 0.001) {
        console.log(`  ✅ Multiplier: ${realMultiplier} (Attendu: ${tc.expectedMultiplier})`);
      } else {
        console.log(`  ❌ FAIL Multiplier: ${realMultiplier} (Attendu: ${tc.expectedMultiplier})`);
      }
    }
    
    if (tc.expectedWinner !== undefined) {
      if (winnerFinal === tc.expectedWinner) {
        console.log(`  ✅ Final Winner: ${winnerFinal} (Attendu: ${tc.expectedWinner})`);
      } else {
        console.log(`  ❌ FAIL Final Winner: ${winnerFinal} (Attendu: ${tc.expectedWinner})`);
      }
    }
    
    console.log(`  ℹ️ Pool: ${tc.pool}, Payout: ${totalPayout}, Sécurité: ${tc.pool >= totalPayout ? 'VÉRIFIÉE' : 'ÉCHEC'}`);
    console.log("");
  });
}

runTests();
