import { db } from './src/config/firebase';

async function testFix() {
  console.log('Testing getDrawHistory logic with fallback...');
  try {
    const drawsRef = db.collection('draws');
    const baseQuery = drawsRef.where('status', '==', 'RESOLVED');

    try {
      console.log('Attempting with orderBy...');
      const snapshot = await baseQuery.orderBy('startTime', 'desc').limit(20).get();
      console.log(`Success with index! Found ${snapshot.size} draws.`);
    } catch (queryError: any) {
      console.warn(`[Firestore] getDrawHistory expectedly failed with orderBy (index missing).`);
      console.log('Falling back to in-memory sort...');
      
      const snapshot = await baseQuery.limit(50).get();
      const draws = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() as any }))
        .sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))
        .slice(0, 20);
        
      console.log(`Success with fallback! Found ${draws.length} draws.`);
      draws.slice(0, 3).forEach(d => console.log(`Draw Data:`, JSON.stringify(d, null, 2)));
    }
  } catch (error: any) {
    console.error('Fatal error in test:', error.message);
  } finally {
    process.exit();
  }
}

testFix();
