// Réplica del CLI oficial de Unlighthouse (@unlighthouse/cli/dist/cli.mjs).
// Mismas opciones y mismo motor: solo fija el puerto interno, no abre el
// navegador y termina al acabar. Los informes Lighthouse quedan en disco
// (.unlighthouse/<host>/<id>/reports/**/lighthouse.html) sin modificar.
import { setMaxListeners } from 'node:events';
import { createUnlighthouse, useLogger } from '@unlighthouse/core';
import { createServer } from '@unlighthouse/server';
import { createCli, pickOptions, validateHost, validateOptions } from '../node_modules/@unlighthouse/cli/dist/_chunks/util.mjs';

const send = msg => process.send?.(msg);
const { options } = createCli().parse();
const port = Number(process.env.UNLIGHTHOUSE_PORT || 5678);

async function run() {
  const start = Date.now();
  if (options.help || options.version) return;
  setMaxListeners(0);
  const picked = pickOptions(options);
  const unlighthouse = await createUnlighthouse({
    ...picked,
    // Solo cambia el idioma de los textos del informe, no las mediciones.
    lighthouseOptions: { ...picked.lighthouseOptions, locale: process.env.LIGHTHOUSE_LOCALE || 'es' },
    server: { port, open: false, showURL: false },
    hooks: { 'resolved-config': async config => { await validateHost(config); } }
  }, { name: 'cli' });
  validateOptions(unlighthouse.resolvedConfig);
  const { server, app } = await createServer();
  await unlighthouse.setServerContext({ url: server.url, server: server.server, app });
  const { routes } = await unlighthouse.start();
  const logger = useLogger();
  const shutdown = async code => {
    await unlighthouse.worker.cluster.close().catch(() => {});
    await server.close().catch(() => {});
    process.exit(code);
  };
  send({ type: 'ready', api: unlighthouse.runtimeSettings.apiUrl, site: unlighthouse.resolvedConfig.site, outputPath: unlighthouse.runtimeSettings.outputPath });
  if (!unlighthouse.worker.reports().length) {
    if (!routes.length) logger.error('Failed to queue routes for scanning. Please check the logs with debug enabled.');
    send({ type: 'error', message: 'No se pudieron encolar rutas para analizar.' });
    return shutdown(1);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('message', msg => { if (msg === 'stop') shutdown(0); });
  unlighthouse.hooks.hook('worker-finished', async () => {
    const seconds = Math.round((Date.now() - start) / 1000);
    unlighthouse.worker.clearProgressDisplay();
    logger.success(`Unlighthouse has finished scanning ${unlighthouse.resolvedConfig.site}: ${unlighthouse.worker.reports().length} routes in ${seconds}s.`);
    send({ type: 'finished', seconds });
    await shutdown(0);
  });
}
run().catch(e => { send({ type: 'error', message: e.message }); console.error(e); process.exit(1); });
