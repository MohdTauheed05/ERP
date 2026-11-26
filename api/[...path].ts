Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
import type { Request, Response } from 'express';
import { createApp } from '../server/app.ts';

const app = createApp();

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
  regions: ['dxb1'],
};

export default function handler(req: Request, res: Response): void {
  app(req, res);
}
