import { Response } from 'express';
import { db } from '../config/firebase';
import { AuthenticatedRequest } from '../middleware/auth';
import { Draw } from '../types';

export const getCurrentDraw = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const nowIso = new Date().toISOString();
    const drawsRef = db.collection('draws');
    
    // Find the OPEN draw where current time is within bounds
    const snapshot = await drawsRef
      .where('status', '==', 'OPEN')
      .get();
    
    // Manual filtering for time bounds to avoid complex Firestore indexing if possible
    const currentDraw = snapshot.docs.find(doc => {
      const data = doc.data() as Draw;
      return nowIso >= data.startTime && nowIso < data.endTime;
    });
    
    if (!currentDraw) {
      return res.status(200).json(null);
    }
    
    res.status(200).json({ id: currentDraw.id, ...currentDraw.data() });
    
  } catch (error) {
    console.error('Error fetching current draw:', error);
    res.status(500).json({ error: 'Failed to fetch current draw' });
  }
};

// Public version (no auth required)
export const getActiveDraw = async (_req: any, res: Response) => {
  try {
    const nowIso = new Date().toISOString();
    const snapshot = await db.collection('draws')
      .where('status', '==', 'OPEN')
      .get();
    
    const currentDraw = snapshot.docs.find(doc => {
      const data = doc.data() as Draw;
      return nowIso >= data.startTime && nowIso < data.endTime;
    });
    
    if (!currentDraw) return res.status(200).json(null);
    res.status(200).json({ id: currentDraw.id, ...currentDraw.data() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch active draw' });
  }
};

export const getDrawHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const drawsRef = db.collection('draws');
    const baseQuery = drawsRef.where('status', '==', 'RESOLVED');

    try {
      // Tentative avec index pour de meilleures performances
      const snapshot = await baseQuery.orderBy('startTime', 'desc').limit(20).get();
      const draws = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
      return res.status(200).json(draws);
    } catch (queryError: any) {
      console.warn(`[Firestore] getDrawHistory a échoué avec orderBy. Basculement sur le tri en mémoire.`, queryError.message);
      
      // Repli : Récupération sans tri puis tri en mémoire (évite l'erreur 500)
      const snapshot = await baseQuery.limit(50).get();
      const draws = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
      
      // Tri en mémoire ultra-robuste (multi-critères)
      const getMs = (draw: any) => {
        const val = draw.startTime || draw.draw_date || draw.created_at;
        if (!val) return 0;
        if (typeof val === 'string') {
          const t = new Date(val).getTime();
          return isNaN(t) ? 0 : t;
        }
        if (val.toDate) return val.toDate().getTime();
        return new Date(val).getTime() || 0;
      };
      
      draws.sort((a, b) => getMs(b) - getMs(a));

      return res.status(200).json(draws.slice(0, 20));
    }
  } catch (error) {
    console.error('Error fetching draw history:', error);
    res.status(500).json({ error: 'Failed to fetch draw history' });
  }
};
