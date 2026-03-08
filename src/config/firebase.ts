import * as admin from 'firebase-admin';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  try {
    const serviceAccountPath = path.join(process.cwd(), 'serviceAccountKey.json');
    
    if (fs.existsSync(serviceAccountPath)) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountPath),
      });
      console.log('Firebase Admin initialized successfully using serviceAccountKey.json');
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      let privateKey = process.env.FIREBASE_PRIVATE_KEY;

      if (!projectId || !clientEmail || !privateKey) {
        throw new Error('Missing Firebase configuration: serviceAccountKey.json not found and environment variables are missing');
      }

      // Super-Robust private key parsing for Production (Render/Vercel)
      if (privateKey) {
        // 1. Remove surrounding whitespace and quotes
        privateKey = privateKey.trim();
        if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
          privateKey = privateKey.substring(1, privateKey.length - 1);
        }
        
        // 2. Handle escaped newlines (e.g. \n)
        privateKey = privateKey.replace(/\\n/g, '\n');
        
        // 3. Fix potential "one-line" PEM where actual newlines are missing but required between headers
        if (privateKey.includes('-----BEGIN PRIVATE KEY-----') && !privateKey.includes('\n')) {
          privateKey = privateKey
            .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
            .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
        }
      }

      console.log(`[Firebase] Initializing for ${projectId}`);
      console.log(`[Firebase] Key Length: ${privateKey?.length}`);
      console.log(`[Firebase] Header present: ${privateKey?.includes('BEGIN PRIVATE KEY')}`);
      console.log(`[Firebase] Actual newlines count: ${(privateKey?.match(/\n/g) || []).length}`);

      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      console.log('Firebase Admin initialized successfully using environment variables');
    }
  } catch (error) {
    console.error('Firebase Admin initialization error', error);
  }
}

export const db = admin.firestore();
export const firebaseAuth = admin.auth();
