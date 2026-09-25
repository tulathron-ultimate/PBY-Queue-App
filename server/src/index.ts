import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const { app } = await buildApp(cfg);

if (!cfg.adminPassword) app.log.warn('ADMIN_PASSWORD is not set: creating events is disabled.');
if (!cfg.publicUrl)
  app.log.warn('PUBLIC_URL is not set: texted links use the host that created the event.');
if (!cfg.webDist) app.log.warn('Web build not found: only the API is served.');
app.log.info(`Texting: tap-to-send${cfg.twilio ? ' + Twilio' : ''}`);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: cfg.port, host: cfg.host });
