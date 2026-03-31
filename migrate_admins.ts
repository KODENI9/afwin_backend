import { db } from './src/config/firebase';
import { UserRole } from './src/types';

/**
 * MIGRATION SCRIPT: Promote all current 'admin' users to 'SUPER_ADMIN'
 * This ensures no one is locked out after the RBAC update.
 */
async function migrateAdmins() {
  console.log('--- Starting Admin Migration ---');
  
  try {
    const snapshot = await db.collection('profiles')
      .where('role', '==', 'admin')
      .get();
    
    if (snapshot.empty) {
      console.log('No legacy admins found to migrate.');
      return;
    }

    console.log(`Found ${snapshot.size} legacy admins. Promoting to SUPER_ADMIN...`);
    
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.update(doc.ref, { 
        role: UserRole.SUPER_ADMIN,
        permissions: [], // Super Admin ignores permissions anyway
        updated_at: new Date().toISOString()
      });
      console.log(`- Scheduled promotion for: ${doc.id} (${doc.data().display_name})`);
    });

    await batch.commit();
    console.log('--- Migration Completed Successfully ---');
  } catch (error) {
    console.error('Migration FAILED:', error);
  }
}

migrateAdmins().catch(console.error);
