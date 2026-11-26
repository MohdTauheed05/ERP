import type { Request, Response } from 'express';
import { createApp } from './app.ts';

const app = createApp();

export function handleVercelRequest(req: Request, res: Response): void {
  app(req, res);
}

