import { createApp } from './app.js';
import { startWorker } from './worker.js';
import { config } from './config.js';
import { log } from './logger.js';

const server = createApp().listen(config.port, () => log.info('server.listening', { port: config.port }));
const stopWorker = config.worker.enabled ? startWorker() : null;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log.info('shutdown', { signal });
    if (stopWorker) await stopWorker();
    server.close();
    process.exit(0);
  });
}
