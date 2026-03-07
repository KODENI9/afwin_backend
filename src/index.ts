import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import drawRoutes from './routes/draw.routes';
import betRoutes from './routes/bet.routes';
import walletRoutes from './routes/wallet.routes';
import adminRoutes from './routes/admin.routes';
import profileRoutes from './routes/profile.routes';
import notificationRoutes from './routes/notification.routes';
import { maintenanceMiddleware } from './middleware/maintenance';
import { startDrawScheduler, ensureTodayDraw } from './jobs/drawScheduler';

// No changes needed here, just removing the old call

const app = express();
const port = process.env.PORT || 3000;

console.log(`[Config] CLERK_SECRET_KEY present: ${!!process.env.CLERK_SECRET_KEY}`);

// ── Security Headers ──────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:4173'
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// ── JSON body ─────────────────────────────────────────────────────────────
app.use(express.json());

// ── Rate Limiters ─────────────────────────────────────────────────────────
const betLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 5,
  message: { error: 'Trop de requêtes. Attendez une minute avant de réessayer.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const depositLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 5,
  message: { error: 'Trop de tentatives de dépôt. Attendez 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Limite de requêtes atteinte. Réessayez dans une minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', globalLimiter);

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Maintenance mode (applies to protected API routes only) ───────────────
app.use('/api/bets', maintenanceMiddleware);
app.use('/api/wallet', maintenanceMiddleware);

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/draws', drawRoutes);
app.use('/api/bets', betLimiter, betRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/notifications', notificationRoutes);

// ── Start server ──────────────────────────────────────────────────────────
app.listen(port, async () => {
  console.log(`Server is running on port ${port}`);

  // Ensure today's draw exists on startup
  try {
    await ensureTodayDraw();
  } catch (err) {
    console.error('[Startup] Error ensuring today\'s draw exists:', err);
  }

  // Start scheduled jobs
  startDrawScheduler();
});
