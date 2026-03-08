import { parseMobileMoneySMS } from './src/utils/smsParser';

const testSms = "Transfert reussi. Montant: 300,00 FCFA Beneficiaire: 22898171651 Date: 08/03/2026 00:51:32. Nouveau solde Moov Money: 149,00 FCFA Txn ID: 040497126217";

const result = parseMobileMoneySMS(testSms);
console.log("SMS result:", JSON.stringify(result, null, 2));

if (result && result.amount === 300) {
  console.log("✅ Success: Amount is 300");
} else {
  console.log("❌ Failure: Amount is", result?.amount);
}

if (result && result.reference === "040497126217") {
  console.log("✅ Success: Reference is 040497126217");
} else {
  console.log("❌ Failure: Reference is", result?.reference);
}
