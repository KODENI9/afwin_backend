import { db } from './src/config/firebase';

async function testTransactions() {
  const userId = 'user_2te9fW9pL8zQ5W8mXy6n6vH6e8r'; // Example ID if possible, or just a dummy
  console.log(`Testing transactions for user: ${userId}`);
  
  try {
    const snapshot = await db.collection('transactions')
      .where('user_id', '==', userId)
      .limit(50)
      .get();
    
    console.log(`Found ${snapshot.size} transactions.`);
    const transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
    
    transactions.sort((a: any, b: any) => (b.created_at || '').localeCompare(a.created_at || ''));
    console.log('Sorted successfully.');
    
    transactions.slice(0, 5).forEach(tx => {
      console.log(` - ${tx.id}: ${tx.type} | ${tx.amount} | ${tx.created_at}`);
    });
    
  } catch (error: any) {
    console.error('Error in test:', error.message);
    if (error.details) console.error('Details:', error.details);
  } finally {
    process.exit();
  }
}

testTransactions();
