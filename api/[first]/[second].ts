import type { Request, Response } from 'express';
import { handleVercelRequest } from '../../server/vercel-handler.ts';

export const config = { api: { bodyParser: false } };
export const maxDuration = 60;

export default function handler(req: Request, res: Response): void {
  handleVercelRequest(req, res);
}

