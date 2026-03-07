import { Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import { AuthenticatedRequest } from './auth';
import { Draw } from '../types';

export const betGuard = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const { draw_id } = req.body;

  if (!draw_id) {
    return res.status(400).json({ error: 'ID du tirage manquant' });
  }

  try {
    const drawRef = db.collection('draws').doc(draw_id);
    const drawDoc = await drawRef.get();

    if (!drawDoc.exists) {
      return res.status(404).json({ error: 'Tirage non trouvé' });
    }

    const drawData = drawDoc.data() as Draw;

    // 1. Check Status
    if (drawData.status !== 'OPEN') {
      return res.status(403).json({ error: 'Les mises sont fermées pour ce tirage.' });
    }

    // 2. Check Server Time
    const now = new Date();
    // Assuming resolve is at 18:00, cutoff is 17:45
    // We can also make this dynamic by storing cutoff in drawData if needed
    const cutoffDate = new Date(drawData.draw_date + 'T17:45:00'); 
    
    // Note: ensure timezone consistency. If Africa/Abidjan is UTC, use T17:45:00Z
    // For now, let's use the local hour check if TZ is set on the server
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const timeValue = currentHour * 60 + currentMinute;
    const cutoffValue = 17 * 60 + 45;

    if (timeValue >= cutoffValue) {
      return res.status(403).json({ error: 'Il est trop tard pour parier aujourd\'hui (Limite 17:45).' });
    }

    next();
  } catch (error) {
    console.error('BetGuard Error:', error);
    res.status(500).json({ error: 'Erreur interne de validation du pari.' });
  }
};
