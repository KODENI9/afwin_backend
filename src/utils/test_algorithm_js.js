
/**
 * Test script for resolveWinningNumber algorithm
 * Run with: npx ts-node path/to/this/file.ts
 */

function resolveWinningNumber(snapshotTotals: Record<any, any>): any {
  const anys = Object.keys(snapshotTotals).map(Number).filter(n => n >= 1 && n <= 9);
  const totals = anys.map(n => snapshotTotals[n] || 0);
  const allZero = totals.every(t => t === 0);

  if (allZero) {
    return -1; // Special case for testing: "Random 1-9"
  }

  const positiveEntries = anys
    .map(n => ({ any: n, total: snapshotTotals[n] || 0 }))
    .filter(e => e.total > 0);

  const minTotal = Math.min(...positiveEntries.map(e => e.total || 0));
  const candidates = positiveEntries
    .filter(e => e.total === minTotal)
    .map(e => e.any);

  if (candidates.length === 1) return candidates[0];
  return -2; // Special case for testing: "Random among ties"
}

const tests = [
  {
    name: "CAS 1 - Différentes valeurs, aucune à 0",
    input: { 1: 100, 2: 200, 3: 300, 4: 400, 5: 500, 6: 600, 7: 700, 8: 800, 9: 900 },
    expected: 1
  },
  {
    name: "CAS 2 - Valeurs à 0 et positives",
    input: { 1: 1000, 2: 200, 3: 300,
         4: 4000, 
         5: 0, 
         6: 0, 
         7: 500,
          8: 600,
           9: 700 },
    expected: 2
  },
  {
    name: "CAS 3 - 0 et positives identiques",
    input: { 1: 1000, 2: 1000, 3: 0, 4: 1000, 5: 0, 6: 1000, 7: 1000, 8: 1000, 9: 1000 },
    expected: -2
  },
  {
    name: "CAS 4 - Toutes identiques > 0",
    input: { 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000, 6: 1000, 7: 1000, 8: 1000, 9: 1000 },
    expected: -2
  },
  {
    name: "CAS 5 - Minimum partagé",
    input: { 1: 100, 2: 200, 3: 100, 4: 500, 5: 600, 6: 700, 7: 800, 8: 900, 9: 1000 },
    expected: -2
  },
  {
    name: "CAS 6 - Toutes à 0",
    input: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 },
    expected: -1
  }
];

console.log("--- STARTING ALGORITHM TESTS ---");
tests.forEach(t => {
  const result = resolveWinningNumber(t.input);
  const status = result === t.expected ? "✅ PASSED" : "❌ FAILED";
  console.log(`${status}: ${t.name} (Result: ${result}, Expected: ${t.expected})`);
});
console.log("--- TESTS FINISHED ---");
