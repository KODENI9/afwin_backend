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

      // Robust private key parsing for Production (Render/Heroku/Railway)
      if (privateKey) {
        // 1. Remove surrounding quotes if they exist
        privateKey = privateKey.trim();
        if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
          privateKey = privateKey.substring(1, privateKey.length - 1);
        }
        // 2. Map literal \n sequences to actual newlines
        privateKey = privateKey.replace(/\\n/g, '\n');
      }

      console.log(`[Firebase] Initializing with ProjectID: ${projectId}, Email: ${clientEmail}`);
      console.log(`[Firebase] Private Key length: ${privateKey?.length || 0} characters`);
      if (privateKey && !privateKey.includes('BEGIN PRIVATE KEY')) {
        console.warn('[Firebase] WARNING: Private Key does not contain BEGIN PRIVATE KEY header!');
      }

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
