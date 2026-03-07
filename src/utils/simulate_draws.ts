import { DrawService } from '../services/draw.service';

function runSimulation(label: string, snapshot: Record<number, number>, iterations: number = 1000) {
  console.log(`\n--- SIMULATION: ${label} ---`);
  console.log(`Snapshot: ${JSON.stringify(snapshot)}`);
  
  const results: Record<number, number> = {};
  for (let i = 0; i < iterations; i++) {
    const winner = DrawService.resolveWinningNumber(snapshot);
    results[winner] = (results[winner] || 0) + 1;
  }
  
  console.log(`Results over ${iterations} iterations:`);
  Object.keys(results).sort().forEach(numStr => {
    const num = Number(numStr);
    const count = results[num] || 0;
    const pct = ((count / iterations) * 100).toFixed(1);
    console.log(`  Number ${num}: ${count} times (${pct}%)`);
  });
}

// 1. All zero (no bets)
runSimulation("CASE 1 - No bets (All zero)", {
    1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0
});

// 2. Clear winner (one number has bets, others have 0)
// The logic should only consider positive values if they exist? 
// No, the rule is "least bet". If some numbers have 0, they are technically the minimum.
// However, the rule "least bid" often implies "minimum positive" if people bet.
// The user request said: "Assure-toi que les valeurs 0 sont filtrées uniquement si d’autres valeurs positives existent."
// This means if there are positive values, we ignore the 0s? Let's check my implementation.
// My implementation: 
// const positiveEntries = entries.filter(e => e.total > 0);
// const minTotal = Math.min(...positiveEntries.map(e => e.total));
// Yes, it filters out 0s if positive values exist.

runSimulation("CASE 2 - One positive bet (Winner should be that number)", {
    1: 1000, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0
});

// 3. Simple Tie (two numbers with same minimum positive amount)
runSimulation("CASE 3 - Simple Tie (1 and 2 both have 1000)", {
    1: 1000, 2: 1000, 3: 5000, 4: 10000, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0
});

// 4. Mix of bets
runSimulation("CASE 4 - Mix of bets (Winner should be 3)", {
    1: 5000, 2: 3000, 3: 1000, 4: 10000, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0
});

// 5. Invalid numbers in snapshot (should be ignored by the algorithm)
runSimulation("CASE 5 - Invalid numbers (ignore 10 and 99)", {
    1: 5000, 2: 3000, 3: 1000, 10: 50, 99: 10
} as any);
