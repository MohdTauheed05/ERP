Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './server/app.ts';
import { getDb } from './server/db.ts';

async function startServer() {
  getDb();
  const app = createApp();
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
    }
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => console.log(`PetroBlend Enterprise ERP running on http://0.0.0.0:${port}`));
}

if (process.env.VERCEL !== '1' && process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch((err) => {
    console.error('Failed to start ERP server:', err);
    process.exit(1);
  });
}
