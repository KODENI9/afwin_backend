import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';

// Middleware to protect routes that require authentication
// This automatically validates the session token and injects 'req.auth'
const clerkAuth = ClerkExpressRequireAuth({});

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  
  // 1. Manuel check to avoid Clerk blowing up on missing header
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn(`[Auth] Rejected: Missing or invalid Bearer token for ${req.path}`);
    return res.status(401).json({ error: 'Unauthenticated', message: 'Missing Authorization header' });
  }

  // 2. Delegate to Clerk with error catch
  try {
    return (clerkAuth as any)(req, res, (err: any) => {
      if (err) {
        console.error(`[Auth] Clerk validation failed for ${req.path}:`, err.message);
        return res.status(401).json({ error: 'Unauthenticated', message: err.message });
      }
      next();
    });
  } catch (err: any) {
    console.error(`[Auth] CRITICAL error in Clerk middleware for ${req.path}:`, err.message);
    return res.status(500).json({ error: 'Internal server error during authentication' });
  }
};

// Middleware to protect routes that require 'admin' role
export const requireAdmin = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.auth?.userId) {
    console.warn('requireAdmin: No userId in auth object');
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  try {
    const profileDoc = await db.collection('profiles').doc(req.auth.userId).get();
    
    if (!profileDoc.exists) {
      console.warn(`requireAdmin: Profile not found for user ${req.auth.userId}`);
      return res.status(403).json({ error: 'Admin only access' });
    }

    const role = profileDoc.data()?.role;
    if (role !== 'admin') {
      console.warn(`requireAdmin: User ${req.auth.userId} has role ${role}, not admin`);
      return res.status(403).json({ error: 'Admin only access' });
    }

    console.log(`requireAdmin: Access granted for user ${req.auth.userId}`);
    next();
  } catch (error) {
    console.error('Error in requireAdmin middleware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// For typed Requests
export interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    sessionId: string;
    getToken: () => Promise<string>;
    claims: {
      name?: string;
      fullName?: string;
      email?: string;
      [key: string]: any;
    };
  };
}
