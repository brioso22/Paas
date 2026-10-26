import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ConfigError } from './config.js';
import { createContext } from './context.js';
import { createApp } from './app.js';

// En producción systemd inyecta el .env con EnvironmentFile; en local lo cargamos aquí.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    console.error('\nRevisa tu archivo .env (puedes partir de .env.example o ejecutar "node scripts/init-env.js").');
    process.exit(1);
  }
  throw err;
}

const ctx = createContext(config);
const app = createApp(ctx);

const server = app.listen(config.port, config.host, () => {
  ctx.logger.info(`Escuchando en http://${config.host}:${config.port}${config.dryRun ? ' (DRY_RUN: no se ejecutan comandos)' : ''}`);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  ctx.logger.info(`Recibido ${signal}, cerrando…`);
  server.close(() => {
    ctx.close();
    process.exit(0);
  });
  // Las conexiones SSE abiertas impedirían cerrar: se fuerzan a los 5 s.
  setTimeout(() => {
    server.closeAllConnections?.();
    ctx.close();
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
