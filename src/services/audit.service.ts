import { db } from '../config/firebase';

export enum AuditAction {
  CLOSE_DRAW = 'CLOSE_DRAW',
  RESOLVE_DRAW = 'RESOLVE_DRAW',
  PAYOUT_DISTRIBUTION = 'PAYOUT_DISTRIBUTION',
  CANCEL_DRAW = 'CANCEL_DRAW',
  MANUAL_ADJUSTMENT = 'MANUAL_ADJUSTMENT',
  BET_PLACED = 'BET_PLACED',
  PAYOUT = 'PAYOUT',
  DEPOSIT = 'DEPOSIT',
  WITHDRAW = 'WITHDRAW',
  DRAW_RESOLVED = 'DRAW_RESOLVED'
}

export const logAudit = async (
  action: AuditAction, 
  data: any, 
  adminId: string = 'SYSTEM',
  userId?: string,
  amount?: number,
  drawId?: string
) => {
  try {
    const auditRef = db.collection('audit_logs').doc();
    await auditRef.set({
      action,
      admin_id: adminId,
      user_id: userId || null,
      amount: amount || 0,
      draw_id: drawId || null,
      timestamp: new Date().toISOString(),
      details: data,
    });
  } catch (error) {
    console.error('Failed to log audit:', error);
  }
};
