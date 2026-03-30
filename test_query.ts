import { db } from './src/config/firebase';

async function testQuery() {
  try {
    console.log('Testing draws history query...');
    const drawsRef = db.collection('draws');
    const snapshot = await drawsRef
      .where('status', '==', 'RESOLVED')
      // .orderBy('startTime', 'desc')
      .limit(20)
      .get();
    
    console.log(`Success! Found ${snapshot.size} draws.`);
    snapshot.docs.forEach(doc => {
      console.log(`ID: ${doc.id}, Status: ${doc.data().status}, startTime: ${doc.data().startTime}`);
    });
  } catch (error: any) {
    console.error('Query failed!');
    console.error('Error message:', error.message);
    if (error.details) console.error('Details:', error.details);
    if (error.code === 9) {
      console.error('This is likely a missing index error.');
    }
  } finally {
    process.exit();
  }
}

testQuery();
