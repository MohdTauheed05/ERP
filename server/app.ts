import express, { type Express } from 'express';
import { getDb } from './db.ts';
import { setPostgresOidcToken } from './postgres-sync.ts';
import authRoutes from './routes/auth.ts';
import userRoutes from './routes/users.ts';
import masterRoutes from './routes/masters.ts';
import procurementRoutes from './routes/procurement.ts';
import inventoryRoutes from './routes/inventory.ts';
import manufacturingRoutes from './routes/manufacturing.ts';
import qualityRoutes from './routes/quality.ts';
import salesRoutes from './routes/sales.ts';
import accountingRoutes from './routes/accounting.ts';
import operationsRoutes from './routes/operations.ts';
import systemRoutes from './routes/system.ts';
import importRoutes from './routes/import.ts';

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', true);

  const configuredOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const vercelOrigins = [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]
    .filter((origin): origin is string => Boolean(origin))
    .map((origin) => `https://${origin}`);
  const allowedOrigins = new Set([...configuredOrigins, ...vercelOrigins]);

  app.use((req, res, next) => {
    const token = req.headers['x-vercel-oidc-token'];
    if (typeof token === 'string') setPostgresOidcToken(token);

    const origin = req.headers.origin;
    const sameOrigin = Boolean(origin && req.headers.host && (() => {
      try { return new URL(origin).host === req.headers.host; } catch { return false; }
    })());
    const originAllowed = Boolean(origin && (sameOrigin || allowedOrigins.has(origin)));
    if (origin && originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(origin && !originAllowed ? 403 : 204);
      return;
    }
    if (origin && !originAllowed) {
      res.status(403).json({ error: 'Origin is not allowed by CORS_ORIGINS' });
      return;
    }
    next();
  });

  app.use(express.json({ limit: process.env.VERCEL ? '4mb' : '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: process.env.VERCEL ? '4mb' : '10mb' }));

  app.get('/api/health', (_req, res) => {
    try {
      getDb().prepare('SELECT 1 AS connected').get();
      res.json({ status: 'ok', database: 'connected', service: 'petroblend-enterprise-erp', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', database: 'unavailable', service: 'petroblend-enterprise-erp', timestamp: new Date().toISOString() });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/admin', userRoutes);
  app.use('/api/masters', masterRoutes);
  app.use('/api/procurement', procurementRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api/manufacturing', manufacturingRoutes);
  app.use('/api/quality', qualityRoutes);
  app.use('/api/sales', salesRoutes);
  app.use('/api/accounting', accountingRoutes);
  app.use('/api/operations', operationsRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/import', importRoutes);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(400).json({ error: message });
  });

  return app;
}
