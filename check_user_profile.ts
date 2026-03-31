import { db } from './src/config/firebase';

async function checkUserProfile(userId: string) {
  console.log(`--- Checking Profile for User ID: ${userId} ---`);
  const doc = await db.collection('profiles').doc(userId).get();
  if (doc.exists) {
    console.log('Profile found:', doc.data());
  } else {
    console.log('Profile NOT found!');
  }
}

// Extracting the user ID from the user's report (truncated)
// The user's ID was user_3Ad...
// Based on the screenshot it's user_3AdV... but let's just search by prefix in profiles
async function findUserByPrefix(prefix: string) {
    console.log(`--- Searching Profiles with prefix: ${prefix} ---`);
    const snapshot = await db.collection('profiles').where('user_id', '>=', prefix).where('user_id', '<=', prefix + '\uf8ff').get();
    snapshot.docs.forEach(d => console.log('Found:', d.id, d.data().display_name));
}

checkUserProfile('user_3AdVp8v0V8tHn5Y8v8B0').catch(console.error); // Dummy guess based on common formats
findUserByPrefix('user_3Ad').catch(console.error);
