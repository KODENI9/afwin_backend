import dotenv from 'dotenv';
dotenv.config();

import { DrawService } from './src/services/draw.service';
import { db }  from './src/config/firebase';

async function main() {
  // Find all CLOSED but not locked draws
  const snap = await db.collection('draws')
    .where('status', '==', 'CLOSED')
    .get();

  const toResolve = snap.docs.filter(d => d.data().locked !== true);

  if (toResolve.length === 0) {
    console.log('No CLOSED un-locked draws found.');
    return;
  }

  for (const doc of toResolve) {
    console.log(`Resolving draw ${doc.id} (status: ${doc.data().status})...`);
    try {
      await DrawService.resolveDraw(doc.id);
      const updated = await db.collection('draws').doc(doc.id).get();
      console.log(`✅ Draw ${doc.id} resolved! Winning number: ${updated.data()?.winningNumber}`);
    } catch (err: any) {
      console.error(`❌ Failed to resolve ${doc.id}:`, err.message);
    }
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
