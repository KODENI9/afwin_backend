import { db } from '../config/firebase';
import { Draw } from '../types';

export class ProfitEngineService {
  /**
   * Evaluates the risk level and profitability of a specific draw.
   */
  static async analyzeDraw(drawId: string) {
    const drawRef = db.collection('draws').doc(drawId);
    const drawDoc = await drawRef.get();
    
    if (!drawDoc.exists) throw new Error('Draw not found');
    const drawData = drawDoc.data() as Draw;

    const totalPool = drawData.totalPool || 0;
    const totalsByNumber = drawData.snapshotTotals || {}; // Use snapshot if available
    
    // Risk assessment: Find 'hot numbers' with high liability
    let maxLiability = 0;
    Object.values(totalsByNumber).forEach(amt => {
      const liability = amt * (drawData.multiplier || 5);
      if (liability > maxLiability) maxLiability = liability;
    });

    const riskLevel = maxLiability > totalPool ? 'HIGH' : 'LOW';
    const suggestedCommission = riskLevel === 'HIGH' ? 0.15 : 0.10;

    return {
      drawId,
      totalPool,
      maxLiability,
      riskLevel,
      recommendation: {
        suggestedCommission,
        suggestion: riskLevel === 'HIGH' 
          ? "Risque de perte élevé. Augmenter la commission ou réduire le multiplicateur pour ce type de session."
          : "Tirage équilibré. Commission standard 10% recommandée."
      }
    };
  }

  /**
   * Simulates total profit based on different commission rates across past draws.
   */
  static async simulateProfitLevels(days: number = 30) {
    const drawsSnapshot = await db.collection('draws')
      .where('status', '==', 'RESOLVED')
      .limit(50)
      .get();

    const totalPoolAll = drawsSnapshot.docs.reduce((sum, d) => sum + (d.data().totalPool || 0), 0);
    const totalPayoutAll = drawsSnapshot.docs.reduce((sum, d) => sum + (d.data().totalPayout || 0), 0);

    // Simulation assuming we apply commission AFTER payout math 
    // (e.g. system takes 10% of pool directly as commission)
    return {
      totalPoolInSample: totalPoolAll,
      currentActualProfit: totalPoolAll - totalPayoutAll,
      simulations: [
        { rate: 0.10, profit: Math.round(totalPoolAll * 0.10), label: "Commission 10% (Flat)" },
        { rate: 0.15, profit: Math.round(totalPoolAll * 0.15), label: "Commission 15% (Flat)" },
        { rate: 0.20, profit: Math.round(totalPoolAll * 0.20), label: "Commission 20% (Aggressif)" }
      ]
    };
  }
}
