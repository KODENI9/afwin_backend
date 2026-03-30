import { db } from './src/config/firebase';

async function testRobustSort() {
  console.log('Testing robust sort with mixed data types...');
  
  const getMs = (val: any) => {
    if (!val) return 0;
    if (typeof val === 'string') return new Date(val).getTime();
    if (val.toDate) return val.toDate().getTime();
    return new Date(val).getTime();
  };

  const mockData = [
    { id: '1', created_at: '2026-03-29T10:00:00.000Z' },
    { id: '2', created_at: { toDate: () => new Date('2026-03-29T11:00:00.000Z') } }, // Mock Firestore Timestamp
    { id: '3', created_at: undefined },
    { id: '4', created_at: '2026-03-28T10:00:00.000Z' }
  ];

  try {
    mockData.sort((a: any, b: any) => getMs(b.created_at) - getMs(a.created_at));
    console.log('Sort successful! Result order:');
    mockData.forEach(d => console.log(` - ${d.id}: ${JSON.stringify(d.created_at)}`));
    
    if (mockData[0].id === '2' && mockData[1].id === '1' && mockData[2].id === '4') {
      console.log('Test Passed: Order is correct (Newest first).');
    } else {
      console.log('Test Failed: Order is incorrect.');
    }
  } catch (err: any) {
    console.error('Test Failed with error:', err.message);
  } finally {
    process.exit();
  }
}

testRobustSort();
