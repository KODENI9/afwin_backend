import { db } from './src/config/firebase';

async function testIndex() {
  const userId = 'user_2te9fW9pL8zQ5W8mXy6n6vH6e8r';
  console.log(`Testing query that requires index for transactions...`);
  
  try {
    const drawsRef = db.collection('transactions');
    const snapshot = await drawsRef
      .where('user_id', '==', userId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();
    
    console.log('Success! Index exists.');
  } catch (error: any) {
    console.log('Error (likely missing index):');
    console.log(error.message);
    if (error.details) console.log('Details:', error.details);
  } finally {
    process.exit();
  }
}

testIndex();
