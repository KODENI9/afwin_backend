import { Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import { AuthenticatedRequest } from './auth';
import { UserRole, AdminPermission, UserProfile } from '../types';

/**
 * Advanced Authorization Middleware (RBAC)
 * 
 * 1. Checks if the user exists in the 'profiles' collection.
 * 2. If UserRole.SUPER_ADMIN -> Full access granted (bypass permission check).
 * 3. If UserRole.ADMIN -> Checks if the required permission is in the user's permissions array.
 * 4. Otherwise -> 403 Forbidden.
 */
export const authorize = (requiredPermission?: AdminPermission) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const userId = req.auth?.userId;

    if (!userId) {
      console.warn(`[Authorize] Access denied: No userId found for ${req.path}`);
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    try {
      const profileDoc = await db.collection('profiles').doc(userId).get();
      
      if (!profileDoc.exists) {
        console.warn(`[Authorize] Access denied: Profile not found for ${userId}`);
        return res.status(403).json({ error: 'Access denied: Profile not found' });
      }

      const profile = profileDoc.data() as UserProfile;
      const role = profile.role;
      const permissions = profile.permissions || [];

      // 1. SUPER_ADMIN -> Master override
      if (role === UserRole.SUPER_ADMIN) {
        // console.log(`[Authorize] Master access granted for SUPER_ADMIN: ${userId}`);
        return next();
      }

      // 2. ADMIN -> Permission based check
      if (role === UserRole.ADMIN || role === 'admin') {
        if (!requiredPermission) {
          console.error(`[Authorize] SECURITY ALERT: No requiredPermission defined for route ${req.path}. Denying access by default.`);
          return res.status(500).json({ 
            error: 'Configuration Error', 
            message: "Une erreur de configuration de sécurité empêche l'accès à cette route." 
          });
        }

        if (Array.isArray(permissions) && permissions.includes(requiredPermission)) {
          return next();
        }

        console.warn(`[Authorize] Access denied: User ${userId} (ADMIN) missing permission [${requiredPermission}] for ${req.path}`);
        return res.status(403).json({ 
          error: 'Forbidden', 
          message: `Accès refusé. Vous n'avez pas la permission [${requiredPermission}].` 
        });
      }

      // 3. Simple USER -> No access to admin routes
      console.warn(`[Authorize] SECURITY ALERT: User ${userId} (USER) tried accessing ${req.path}`);
      return res.status(403).json({ error: 'Forbidden', message: 'Accès réservé aux administrateurs.' });

    } catch (error) {
      console.error('[Authorize] CRITICAL ERROR during authorization check:', error);
      res.status(500).json({ error: 'Internal server error during authorization' });
    }
  };
};
