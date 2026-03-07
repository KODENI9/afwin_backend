import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';

// Middleware to protect routes that require authentication
// This automatically validates the session token and injects 'req.auth'
const clerkAuth = ClerkExpressRequireAuth({});

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  // Debug logging
  const authHeader = req.headers.authorization;
  
  if (!process.env.CLERK_SECRET_KEY) {
    console.error(`[Auth] CRITICAL: CLERK_SECRET_KEY is missing in process.env!`);
    return res.status(500).json({ error: 'Backend configuration error (Secret Key missing)' });
  }

  if (!authHeader) {
    console.warn(`[Auth] No Authorization header found for ${req.method} ${req.url}`);
    // If we want to allow the Clerk middleware to handle the 401:
    return (clerkAuth as any)(req, res, next);
  }

  console.log(`[Auth] Header found for ${req.method} ${req.url}: ${authHeader.substring(0, 20)}...`);
  
  // Wrap to catch potential errors during validation
  try {
    return (clerkAuth as any)(req, res, next);
  } catch (err) {
    console.error(`[Auth] Exception in Clerk middleware:`, err);
    return res.status(401).json({ error: 'Unauthenticated' });
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
