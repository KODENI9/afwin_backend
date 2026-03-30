import { db } from '../config/firebase';
import * as admin from 'firebase-admin'; // Correct import for FieldValue

export class AnalyticsService {
  /**
   * Updates daily stats when a draw is resolved.
   * Calculations:
   * profit = totalPool - totalPayout - referralBonus
   */
  static async updateDailyStats(date: string, data: { 
    bets: number; 
    payouts: number; 
    referrals: number;
    drawId: string;
  }) {
    const statsRef = db.collection('daily_stats').doc(date);
    const FieldValue = require('firebase-admin').firestore.FieldValue;

    try {
      await statsRef.set({
        date,
        totalBets: FieldValue.increment(data.bets),
        totalPayouts: FieldValue.increment(data.payouts),
        totalReferralBonus: FieldValue.increment(data.referrals),
        netProfit: FieldValue.increment(data.bets - data.payouts - data.referrals),
        drawCount: FieldValue.increment(1),
        last_updated: new Date().toISOString()
      }, { merge: true });
      
      console.log(`Daily stats updated for ${date}`);
    } catch (error) {
      console.error('Failed to update daily stats:', error);
    }
  }

  /**
   * Returns stats for the last 30 days formatted for charts.
   */
  static async getDailyHistory(days: number = 30) {
    const snapshot = await db.collection('daily_stats')
      .orderBy('date', 'desc')
      .limit(days)
      .get();

    const stats = snapshot.docs.map(doc => doc.data());
    // Reverse to have chronological order for charts
    stats.reverse();

    return {
      labels: stats.map(s => s.date.split('-')[2]), // Just the day part
      profits: stats.map(s => s.netProfit),
      bets: stats.map(s => s.totalBets),
      payouts: stats.map(s => s.totalPayouts)
    };
  }

  /**
   * Returns global KPIs across the entire system.
   */
  static async getGlobalKPIs() {
    const [profiles, trans, bets] = await Promise.all([
      db.collection('profiles').count().get(),
      db.collection('transactions').where('status', '==', 'approved').get(),
      db.collection('bets').get()
    ]);

    let totalDeposits = 0;
    let totalBets = 0;
    let totalPayouts = 0;

    trans.docs.forEach(doc => {
      const data = doc.data();
      if (data.type === 'deposit') totalDeposits += data.amount;
    });

    bets.docs.forEach(doc => {
      const data = doc.data();
      totalBets += data.amount;
      if (data.status === 'WON') totalPayouts += data.payoutAmount;
    });

    return {
      totalUsers: profiles.data().count,
      totalDeposits,
      totalBets,
      totalPayouts,
      netProfit: totalBets - totalPayouts
    };
  }
}
