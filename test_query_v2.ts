import { db } from './src/config/firebase';
import * as fs from 'fs';

async function testQuery() {
  const logFile = 'test_results.log';
  fs.writeFileSync(logFile, 'Testing draws history query...\n');
  
  try {
    const drawsRef = db.collection('draws');
    // Testing the one that likely fails
    const snapshot = await drawsRef
      .where('status', '==', 'RESOLVED')
      .orderBy('startTime', 'desc')
      .limit(20)
      .get();
    
    fs.appendFileSync(logFile, `Success! Found ${snapshot.size} draws.\n`);
    snapshot.docs.forEach(doc => {
      fs.appendFileSync(logFile, `ID: ${doc.id}, Status: ${doc.data().status}, startTime: ${doc.data().startTime}\n`);
    });
  } catch (error: any) {
    fs.appendFileSync(logFile, `Query failed!\n`);
    fs.appendFileSync(logFile, `Error message: ${error.message}\n`);
    if (error.details) fs.appendFileSync(logFile, `Details: ${error.details}\n`);
    if (error.code === 9) {
      fs.appendFileSync(logFile, `This is likely a missing index error.\n`);
    }
  } finally {
    process.exit();
  }
}

testQuery();
