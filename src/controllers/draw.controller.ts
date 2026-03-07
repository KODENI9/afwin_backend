import { Response } from 'express';
import { db } from '../config/firebase';
import { AuthenticatedRequest } from '../middleware/auth';
import { Draw } from '../types';

export const getCurrentDraw = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const today = new Date().toISOString().substring(0, 10);
    const drawsRef = db.collection('draws');
    
    const snapshot = await drawsRef.where('draw_date', '==', today).limit(1).get();
    
    if (snapshot.empty) {
      // Fetch default multiplier from settings
      const settingsRef = db.collection('settings').doc('game_config');
      const settingsDoc = await settingsRef.get();
      const multiplier = settingsDoc.exists ? (settingsDoc.data()?.multiplier ?? 5) : 5;

      // Create it if it doesn't exist
      const newDraw: Draw = {
        draw_date: today,
        totalPool: 0,
        status: 'OPEN',
        multiplier,
        created_at: new Date().toISOString()
      };
      const docRef = await drawsRef.add(newDraw);
      return res.status(200).json({ id: docRef.id, ...newDraw });
    }
    
    const firstDoc = snapshot.docs[0];
    if (firstDoc) {
      const draw = { id: firstDoc.id, ...firstDoc.data() };
      res.status(200).json(draw);
    } else {
      res.status(404).json({ error: 'Draw not found' });
    }
  } catch (error) {
    console.error('Error fetching current draw:', error);
    res.status(500).json({ error: 'Failed to fetch current draw' });
  }
};

export const getDrawHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const drawsRef = db.collection('draws');
    // Fetch last resolved draws
    const snapshot = await drawsRef
      .where('status', '==', 'RESOLVED')
      .limit(20) 
      .get();
      
    const draws = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
    
    // Sort by resolved date or draw date
    draws.sort((a: any, b: any) => (b.draw_date || '').localeCompare(a.draw_date || ''));
    
    res.status(200).json(draws.slice(0, 10));
  } catch (error) {
    console.error('Error fetching draw history:', error);
    res.status(500).json({ error: 'Failed to fetch draw history' });
  }
};
