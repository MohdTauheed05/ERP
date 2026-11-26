import type { Request, Response } from 'express';
import { createApp } from '../server/app.ts';

const app = createApp();

export const config = {
  api: { bodyParser: false },
};

export const maxDuration = 60;

export default function handler(req: Request, res: Response): void {
  app(req, res);
}

