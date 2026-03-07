import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';

let maintenanceCache: { active: boolean; message: string; updatedAt: number } = {
  active: false,
  message: 'Le service est temporairement en maintenance. Revenez bientôt.',
  updatedAt: 0,
};

const CACHE_TTL_MS = 30 * 1000; // Refresh cache every 30s

const getMaintenanceStatus = async (): Promise<{ active: boolean; message: string }> => {
  const now = Date.now();
  // Return from cache if recent
  if (now - maintenanceCache.updatedAt < CACHE_TTL_MS) {
    return { active: maintenanceCache.active, message: maintenanceCache.message };
  }

  try {
    const doc = await db.collection('settings').doc('maintenance').get();
    if (doc.exists) {
      const data = doc.data();
      maintenanceCache = {
        active: data?.active === true,
        message: data?.message || maintenanceCache.message,
        updatedAt: now,
      };
    } else {
      maintenanceCache = { active: false, message: maintenanceCache.message, updatedAt: now };
    }
  } catch (err) {
    console.error('[Maintenance] Failed to check maintenance status:', err);
  }

  return { active: maintenanceCache.active, message: maintenanceCache.message };
};

export const maintenanceMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const { active, message } = await getMaintenanceStatus();
  if (active) {
    return res.status(503).json({ error: 'maintenance', message });
  }
  next();
};

// Admin endpoint to toggle maintenance mode
export const setMaintenanceMode = async (req: Request, res: Response) => {
  const { active, message } = req.body;
  try {
    await db.collection('settings').doc('maintenance').set({
      active: !!active,
      message: message || 'Le service est temporairement en maintenance.',
      updated_at: new Date().toISOString(),
    }, { merge: true });

    // Invalidate cache immediately
    maintenanceCache.updatedAt = 0;

    res.json({ success: true, active: !!active });
  } catch (err) {
    console.error('[Maintenance] Failed to update maintenance status:', err);
    res.status(500).json({ error: 'Failed to update maintenance status' });
  }
};
