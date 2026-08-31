import { createApp } from './app.js';
import { startWorker } from './worker.js';
import { config } from './config.js';
import { log } from './logger.js';

const server = createApp().listen(config.port, () => log.info('server.listening', { port: config.port }));

// Порт занят это обычная ситуация при локальном запуске, а не повод показывать стек.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`Порт ${config.port} занят. Освободите его или поменяйте PORT в .env\n`);
  } else {
    process.stderr.write(`Не удалось запустить сервер на порту ${config.port}: ${err.message}\n`);
  }
  process.exit(1);
});
const stopWorker = config.worker.enabled ? startWorker() : null;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log.info('shutdown', { signal });
    if (stopWorker) await stopWorker();
    server.close();
    process.exit(0);
  });
}
