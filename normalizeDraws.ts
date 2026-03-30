import { db } from './src/config/firebase';

const normalizeDraws = async () => {
  console.log('--- STARTING NORMALIZATION ---');
  const snapshot = await db.collection('draws').get();
  console.log(`Analyzing ${snapshot.size} documents...`);

  let updatedCount = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data() as any;
    const updates: any = {};
    let shouldUpdate = false;

    // 1. Check for legacy V1 format (missing slotId)
    if (!data.slotId) {
      console.log(`[V1] Found Legacy doc: ${doc.id}`);
      updates.slotId = 'LEGACY';
      shouldUpdate = true;
    }

    // 2. Check for missing startTime / endTime
    if (!data.startTime) {
      // Use drawDate or ID to build default startTime (18:00)
      const datePart = data.draw_date || doc.id.substring(0, 10);
      updates.startTime = `${datePart}T18:00:00.000Z`;
      updates.endTime = `${datePart}T18:00:00.000Z`;
      shouldUpdate = true;
    }

    // 3. Fix Year Inconsistency (2024 -> 2026)
    // If ID starts with 2026 but draw_date has 2024, sync it
    if (doc.id.startsWith('2026') && data.draw_date && data.draw_date.startsWith('2024')) {
      console.log(`[YEAR] Fixing year in ${doc.id}: ${data.draw_date} -> 2026-...`);
      updates.draw_date = data.draw_date.replace('2024', '2026');
      
      // Also update startTime if it was already set or but with 2024
      const currentStart = updates.startTime || data.startTime;
      if (currentStart && currentStart.startsWith('2024')) {
        updates.startTime = currentStart.replace('2024', '2026');
      }
      const currentEnd = updates.endTime || data.endTime;
      if (currentEnd && currentEnd.startsWith('2024')) {
        updates.endTime = currentEnd.replace('2024', '2026');
      }
      shouldUpdate = true;
    }

    if (shouldUpdate) {
      console.log(`Updating ${doc.id}...`, JSON.stringify(updates));
      await db.collection('draws').doc(doc.id).update(updates);
      updatedCount++;
    }
  }

  console.log(`--- FINISHED NORMALIZATION: ${updatedCount} documents updated ---`);
  process.exit(0);
};

normalizeDraws().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
