import express from 'express';
import { join } from 'node:path';
import { apiRouter } from './routes/api.js';
import { config } from './config.js';
import { log } from './logger.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(apiRouter);
  app.use(express.static(join(config.root, 'public')));

  app.use((err, req, res, _next) => {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    log.error('http.unhandled', { path: req.path, error: err.message, stack: err.stack });
    // 5xx осознанно: платёжная система по контракту повторит доставку вебхука.
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
