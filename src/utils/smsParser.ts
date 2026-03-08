/**
 * Extrait un ID de transaction unique depuis le contenu d'un SMS de paiement.
 * Exemples : 
 * - Orange: "Transfert reussi. ID: 154628..."
 * - MTN: "Transaction ID: 827361..."
 */
export const extractTxId = (sms: string): string | null => {
  if (!sms) return null;

  // Regex génériques pour capturer les patterns "ID: 123..." ou "Transaction ID: 123..."
  const patterns = [
    /ID\s*[:\-\s]\s*([A-Za-z0-9]+)/i,
    /Transaction\s*ID\s*[:\-\s]\s*([A-Za-z0-9]+)/i,
    /Txn\s*ID\s*[:\-\s]\s*([A-Za-z0-9]+)/i,
    /Ref\s*[:\-\s]\s*([A-Za-z0-9]+)/i,
    /Trans\.\s*ID\s*[:\-\s]\s*([A-Za-z0-9]+)/i
  ];

  for (const pattern of patterns) {
    const match = sms.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
};

/**
 * Analyse un SMS de Mobile Money pour extraire le montant, la référence et l'opérateur.
 */
export const parseMobileMoneySMS = (sms: string) => {
  if (!sms) return null;

  // 1. Extraire la référence
  const reference = extractTxId(sms);
  if (!reference) return null;

  // 2. Extraire le montant (ex: 5000 CFA, 5.000 FCFA, etc.)
  let amount = 0;
  const amountPatterns = [
    /([0-9\s.,]+)\s*(?:CFA|FCFA|XOF)/i, // 5000 CFA
    /(?:montant|montant de|de)\s*([0-9\s.,]+)\s*(?:CFA|FCFA|XOF)/i,
    /([0-9\s.,]+)\s*(?:F)/i // 5000 F
  ];

  for (const pattern of amountPatterns) {
    const match = sms.match(pattern);
    if (match && match[1]) {
      // Nettoyer le montant plus intelligemment
      const rawAmount = match[1].trim();
      
      // Nouvelle logique de nettoyage
      let clean = rawAmount.replace(/\s/g, ''); // Enlever les espaces
      
      // Si on a ",00" ou ".00" à la fin, on l'enlève car c'est du FCFA (pas de centimes utiles)
      clean = clean.replace(/[,.]00$/, '');
      
      // Si il reste une virgule, on la traite comme un séparateur décimal si suivi de 2 chiffres, 
      // sinon c'est un séparateur de milliers
      if (clean.includes(',')) {
        const parts = clean.split(',');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.length === 2) {
          // ex: 300,50 -> 300.5
          amount = parseFloat(parts.slice(0, -1).join('').replace(/[^0-9]/g, '') + '.' + lastPart);
        } else {
          // ex: 1,000 -> 1000
          amount = parseFloat(clean.replace(/[^0-9]/g, ''));
        }
      } else if (clean.includes('.')) {
        const parts = clean.split('.');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.length === 2) {
          amount = parseFloat(parts.slice(0, -1).join('').replace(/[^0-9]/g, '') + '.' + lastPart);
        } else {
          amount = parseFloat(clean.replace(/[^0-9]/g, ''));
        }
      } else {
        amount = parseFloat(clean.replace(/[^0-9]/g, ''));
      }

      if (amount > 0) break;
    }
  }

  if (amount <= 0) return null;

  // 3. Détecter le fournisseur
  let provider = "Mobile Money";
  if (/orange/i.test(sms)) provider = "Orange";
  else if (/mtn/i.test(sms) || /momo/i.test(sms)) provider = "MTN";
  else if (/moov/i.test(sms) || /flooz/i.test(sms)) provider = "Flooz/Moov";
  else if (/tmoney/i.test(sms)) provider = "T-Money";

  return {
    amount,
    reference,
    provider
  };
};
