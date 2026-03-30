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
import { startDrawScheduler } from './jobs/drawScheduler';

// No changes needed here, just removing the old call

const app = express();
const port = process.env.PORT || 3000;

// LOGGING D'URGENCE : Voir toutes les requêtes entrantes
app.use((req, res, next) => {
  console.log(`[HTTP] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

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
    
    const isAllowed = allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development';
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Request from origin ${origin} rejected. Allowed: ${JSON.stringify(allowedOrigins)}`);
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

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', message: 'Hello from AFWIN API' });
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

// ── Global Error Handler (CATCH-ALL) ──────────────────────────────────────
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(`[ERROR] ${new Date().toISOString()} ${req.method} ${req.url}:`, err.stack || err.message || err);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred',
    path: req.url
  });
});

// ── Start server ──────────────────────────────────────────────────────────
app.listen(port as number, '0.0.0.0', async () => {
  console.log(`Server is running on port ${port}`);

  // Start scheduled jobs
  startDrawScheduler();
});
