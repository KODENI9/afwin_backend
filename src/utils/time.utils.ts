/*D:\afwin\backend\src\utils\time.utils.ts*/

import { db } from '../config/firebase';
import { Draw } from '../types';

export const TIME_SLOTS = [
  { id: "S1", start: "06:00", end: "09:00" },
  { id: "S2", start: "09:00", end: "12:00" },
  { id: "S3", start: "12:00", end: "15:00" },
  { id: "S4", start: "15:00", end: "17:00" },
  { id: "S5", start: "17:00", end: "20:00" },
  { id: "S6", start: "20:00", end: "00:00" }
];                                      

/**
 * Returns the slot that overlaps with the given date (default = now).
 * Since Africa/Lome is UTC+0, we can use UTC methods for strict compliance.
 */

export const getCurrentSlotId = (now: Date = new Date()): string | null => {
  const currentHour = now.getUTCHours();
  
  for (const slot of TIME_SLOTS) {
    const startHour = parseInt(slot.start.split(':')[0]!);
    const endHour = parseInt(slot.end.split(':')[0]!);
    
    if (currentHour >= startHour && currentHour < endHour) {
      return slot.id;
    }
  }
  return null;
};

/**
 * Generates ISO strings for startTime and endTime for a specific slot and date.
 */
export const getSlotBounds = (dateStr: string, slotId: string) => {
  const slot = TIME_SLOTS.find(s => s.id === slotId);
  if (!slot) throw new Error(`Invalid slot ID: ${slotId}`);

  const startTime = new Date(`${dateStr}T${slot.start}:00Z`).toISOString();
  
  // Handle cross-day transitions if end < start (though not in current S1-S5)
  const startH = parseInt(slot.start.split(':')[0]!);
  const endH = parseInt(slot.end.split(':')[0]!);
  
  let endDate = new Date(`${dateStr}T${slot.end}:00Z`);
  if (endH < startH) {
    endDate.setUTCDate(endDate.getUTCDate() + 1);
  }
  const endTime = endDate.toISOString();

  return { startTime, endTime };
};

/**
 * PRODUCTION READY: Creates all draws for a given day (YYYY-MM-DD).
 * Idempotent: Skips if draw already exists.
 */
export const createDailyDraws = async (dateStr: string) => {
  console.log(`[TimeUtils] Creating all draws for date: ${dateStr}`);
  
  // Get default multiplier from settings
  const settingsDoc = await db.collection('settings').doc('game_config').get();
  const multiplier = settingsDoc.exists ? (settingsDoc.data()?.multiplier ?? 5) : 5;

  for (const slot of TIME_SLOTS) {
    const drawId = `${dateStr}-${slot.id}`;
    const drawRef = db.collection('draws').doc(drawId);
    
    // Use transaction for strict idempotence
    await db.runTransaction(async (t) => {
      const doc = await t.get(drawRef);
      if (doc.exists) {
        console.log(`[TimeUtils] Draw ${drawId} already exists. Skipping.`);
        return;
      }

      const { startTime, endTime } = getSlotBounds(dateStr, slot.id);

      const newDraw: Draw = {
        draw_date: dateStr,
        slotId: slot.id,
        startTime,
        endTime,
        status: 'OPEN',
        totalPool: 0,
        multiplier,
        created_at: new Date().toISOString()
      };

      t.set(drawRef, newDraw);
      console.log(`[TimeUtils] Created Draw: ${drawId}`);
    });
  }
};
