import { db } from '../config/firebase';
import { Bet } from '../types';

export class SmartDetectionService {
  /**
   * Calculates the ROI and intelligence score for a single user.
   */
  static async analyzeUser(userId: string) {
    const betsSnapshot = await db.collection('bets')
      .where('user_id', '==', userId)
      .get();

    if (betsSnapshot.empty) return { roi: 0, winRate: 0, score: 0, level: 'LOW' };

    let totalBet = 0;
    let totalGain = 0;
    let wins = 0;

    betsSnapshot.docs.forEach(doc => {
      const data = doc.data() as Bet;
      totalBet += data.amount;
      if (data.status === 'WON') {
        totalGain += data.payoutAmount;
        wins++;
      }
    });

    const roi = totalBet > 0 ? totalGain / totalBet : 0;
    const winRate = wins / betsSnapshot.size;
    
    // Scoring logic: ROI is the main driver, frequency also matters
    let score = (roi * 40) + (winRate * 20);
    if (betsSnapshot.size < 5) score *= 0.5; // Less confidence on low sample size

    let level: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
    if (roi > 2.5 || score > 80) level = 'HIGH';
    else if (roi > 1.5 || score > 50) level = 'MEDIUM';

    return {
      roi: parseFloat(roi.toFixed(2)),
      winRate: parseFloat((winRate * 100).toFixed(1)),
      totalBet,
      totalGain,
      betCount: betsSnapshot.size,
      score: Math.round(score),
      level
    };
  }

  /**
   * Scans for 'smart' or 'suspect' players.
   */
  static async getSmartPlayers(limit: number = 20) {
    // In a real prod app, we'd store these stats on the profile to avoid full scans.
    // For now, we'll fetch users and analyze them.
    const usersSnapshot = await db.collection('profiles').limit(50).get();
    
    const results = await Promise.all(
      usersSnapshot.docs.map(async (doc) => {
        const stats = await this.analyzeUser(doc.id);
        if (stats.level !== 'LOW') {
          return {
            id: doc.id,
            display_name: doc.data().display_name,
            phone: doc.data().phone,
            ...stats
          };
        }
        return null;
      })
    );

    return results
      .filter(r => r !== null)
      .sort((a, b) => (b?.roi || 0) - (a?.roi || 0))
      .slice(0, limit);
  }
}
