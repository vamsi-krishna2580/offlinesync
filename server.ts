import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createBackendApp } from './backend/api/createApp';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer(): Promise<void> {
  const persistPath = path.resolve(process.cwd(), 'data', 'offlinesync_db.json');
  const { app, store } = createBackendApp({ persistPath });

  if (IS_PROD) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[OfflineSync] Server running on http://localhost:${PORT}`);
    console.log(`[OfflineSync] OfflineShop:         http://localhost:${PORT}/`);
    console.log(`[OfflineSync] OfflineSync Monitor: http://localhost:${PORT}/monitor`);
  });

  const gracefulShutdown = () => {
    store.close();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

startServer().catch((err) => {
  console.error('[OfflineSync] Failed to start server:', err);
  process.exit(1);
});
