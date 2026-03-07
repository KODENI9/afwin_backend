import { parseMobileMoneySMS } from './smsParser';

const testCases = [
  {
    name: 'Flooz',
    text: 'Transfert de 5000 FCFA reçu de 90000000. Ref: 123456789. Nouveau solde: 15000 FCFA.',
    expected: { amount: 5000, reference: '123456789', provider: 'Flooz' }
  },
  {
    name: 'T-Money',
    text: 'T-Money: Vous avez recu 2000 CFA de 91000000. TransID: TM888999. Votre nouveau solde est 2500 CFA.',
    expected: { amount: 2000, reference: 'TM888999', provider: 'T-Money' }
  },
  {
    name: 'Moov',
    text: 'Moov Money: Reception de 10,000 FCFA. ID: MV123456. Merci.',
    expected: { amount: 10000, reference: 'MV123456', provider: 'Moov' }
  },
  {
    name: 'Orange',
    text: 'Orange Money: Vous avez recu 1500 FCFA. Transaction Ref: OR777. Nouveau solde: 3000 FCFA.',
    expected: { amount: 1500, reference: 'OR777', provider: 'Orange' }
  },
  {
    name: 'Generic',
    text: 'Recu 500 CFA. ID: GEN001',
    expected: { amount: 500, reference: 'GEN001', provider: 'Unknown/Other' }
  }
];

console.log('Testing SMS Parser...');
let successCount = 0;

testCases.forEach(tc => {
  const result = parseMobileMoneySMS(tc.text);
  if (result && result.amount === tc.expected.amount && result.reference === tc.expected.reference && result.provider === tc.expected.provider) {
    console.log(`✅ [${tc.name}] Passed`);
    successCount++;
  } else {
    console.error(`❌ [${tc.name}] Failed`);
    console.error('Expected:', tc.expected);
    console.error('Got:', result);
  }
});

console.log(`\nSummary: ${successCount}/${testCases.length} tests passed.`);
