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

    // 2. Check Time dynamically against draw's explicit endTime
    const nowMs = new Date().getTime();
    
    // Safety check: ensure endTime exists
    if (drawData.endTime) {
      const endMs = new Date(drawData.endTime).getTime();
      
      // Cutoff is 15 minutes before the draw ends/resolves
      const cutoffMs = endMs - (15 * 60000); 

      if (nowMs >= cutoffMs) {
         // Formatting the time for the error message display
         const cutoffDate = new Date(cutoffMs);
         const displayTime = `${cutoffDate.getHours().toString().padStart(2, '0')}:${cutoffDate.getMinutes().toString().padStart(2, '0')}`;
         return res.status(403).json({ error: `Il est trop tard pour parier sur ce créneau (Fermeture: ${displayTime}).` });
      }
    }

    next();
  } catch (error) {
    console.error('BetGuard Error:', error);
    res.status(500).json({ error: 'Erreur interne de validation du pari.' });
  }
};
