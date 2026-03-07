import { db } from '../config/firebase';

export enum AuditAction {
  CLOSE_DRAW = 'CLOSE_DRAW',
  RESOLVE_DRAW = 'RESOLVE_DRAW',
  PAYOUT_DISTRIBUTION = 'PAYOUT_DISTRIBUTION',
  CANCEL_DRAW = 'CANCEL_DRAW',
  MANUAL_ADJUSTMENT = 'MANUAL_ADJUSTMENT'
}

export const logAudit = async (action: AuditAction, data: any, adminId: string = 'SYSTEM') => {
  try {
    const auditRef = db.collection('audit_logs').doc();
    await auditRef.set({
      action,
      admin_id: adminId,
      timestamp: new Date().toISOString(),
      details: data,
    });
  } catch (error) {
    console.error('Failed to log audit:', error);
    // Don't throw to avoid breaking the main transaction, but in a real system this might be critical
  }
};
