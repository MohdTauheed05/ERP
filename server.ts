import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { getDb } from './server/db.ts';
import authRoutes from './server/routes/auth.ts';
import userRoutes from './server/routes/users.ts';
import masterRoutes from './server/routes/masters.ts';
import procurementRoutes from './server/routes/procurement.ts';
import inventoryRoutes from './server/routes/inventory.ts';
import manufacturingRoutes from './server/routes/manufacturing.ts';
import qualityRoutes from './server/routes/quality.ts';
import salesRoutes from './server/routes/sales.ts';
import accountingRoutes from './server/routes/accounting.ts';
import operationsRoutes from './server/routes/operations.ts';
import systemRoutes from './server/routes/system.ts';
import importRoutes from './server/routes/import.ts';

async function startServer() {
  // Initialize SQLite database & migrations before accepting requests
  getDb();

  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(origin && !allowedOrigins.includes(origin) ? 403 : 204);
      return;
    }
    if (origin && !allowedOrigins.includes(origin)) {
      res.status(403).json({ error: 'Origin is not allowed by CORS_ORIGINS' });
      return;
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Healthcheck
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'petroblend-enterprise-erp', timestamp: new Date().toISOString() });
  });

  // API Routers
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

  // Error handler
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(400).json({ error: message });
  });

  // Mount Vite dev middleware or serve static production build
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PetroBlend Enterprise ERP running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start ERP server:', err);
  process.exit(1);
});
