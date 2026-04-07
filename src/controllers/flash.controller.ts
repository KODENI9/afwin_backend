import { Response } from 'express';
import { db } from '../config/firebase';
import { FlashDraw } from '../types';
import { FlashService } from '../services/flash.service';
import { AuthenticatedRequest } from '../middleware/auth';
import { logAudit, AuditAction } from '../services/audit.service';

/**
 * ── ADMIN : Créer un Flash manuellement ──────────────────────────────────────
 * POST /api/admin/flash/create
 * Request failed with status code 404
 
 */
export const createFlash = async (req: AuthenticatedRequest, res: Response) => {
  const adminId = req.auth?.userId;
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' });

  const { label, durationMinutes, multiplier } = req.body;

  if (!label || !durationMinutes || !multiplier) {
    return res.status(400).json({ error: 'label, durationMinutes et multiplier sont obligatoires' });
  }
  if (durationMinutes < 2 || durationMinutes > 60) {
    return res.status(400).json({ error: 'Durée invalide (2-60 minutes)' });
  }
  if (multiplier < 2 || multiplier > 20) {
    return res.status(400).json({ error: 'Multiplicateur invalide (2-20x)' });
  }

  try {
    // Vérifier qu'aucun Flash n'est déjà OPEN
    const existing = await FlashService.getActiveFlash();
    if (existing) {
      return res.status(409).json({
        error: `Un Flash est déjà en cours : "${existing.label}" (se termine à ${new Date(existing.endTime).toLocaleTimeString('fr-FR')})`
      });
    }

    const flashId = await FlashService.createFlash({
      label,
      durationMinutes: Number(durationMinutes),
      multiplier: Number(multiplier),
      createdBy: adminId,
      autoSchedule: false,
    });

    res.status(201).json({
      success: true,
      flashId,
      message: `Flash "${label}" lancé pour ${durationMinutes} minutes (x${multiplier}).`,
    });
  } catch (error: any) {
    console.error('[Flash] createFlash error:', error);
    res.status(400).json({ error: error.message });
  }
};

/**
 * ── ADMIN : Résoudre un Flash manuellement ───────────────────────────────────
 * POST /api/admin/flash/resolve
 */
export const resolveFlashManual = async (req: AuthenticatedRequest, res: Response) => {
  const adminId = req.auth?.userId;
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' });

  const { flash_id } = req.body;
  if (!flash_id) return res.status(400).json({ error: 'flash_id obligatoire' });

  try {
    const flashRef = db.collection('flash_draws').doc(flash_id);
    const doc = await flashRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Flash introuvable' });

    const data = doc.data() as FlashDraw;

    if (data.status === 'OPEN') {
      await FlashService.closeFlash(flash_id);
    }
    await FlashService.resolveFlash(flash_id);

    // Le payout sera déclenché automatiquement par le scheduler
    res.status(200).json({ success: true, message: 'Flash résolu. Paiements en cours de traitement.' });
  } catch (error: any) {
    console.error('[Flash] resolveFlashManual error:', error);
    res.status(400).json({ error: error.message });
  }
};

/**
 * ── ADMIN : Liste des Flash récents ─────────────────────────────────────────
 * GET /api/admin/flash/list
 */
export const listFlashes = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const snapshot = await db.collection('flash_draws')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const flashes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(flashes);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * ── ADMIN : Sauvegarder la config des plages horaires ───────────────────────
 * POST /api/admin/flash/schedule
 */
export const saveFlashSchedule = async (req: AuthenticatedRequest, res: Response) => {
  const { config } = req.body;
  if (!config) return res.status(400).json({ error: 'config obligatoire' });

  try {
    await FlashService.saveScheduleConfig(config);
    res.status(200).json({ success: true, message: 'Configuration Flash sauvegardée.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * ── ADMIN : Récupérer la config des plages horaires ─────────────────────────
 * GET /api/admin/flash/schedule
 */
export const getFlashSchedule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const config = await FlashService.getScheduleConfig();
    res.status(200).json(config);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * ── PUBLIC : Flash actif (pour le frontend user) ────────────────────────────
 * GET /api/flash/active
 */
export const getActiveFlash = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const flash = await FlashService.getActiveFlash();
    if (!flash) return res.status(200).json(null);
    res.status(200).json(flash);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};