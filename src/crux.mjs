// Datos de usuarios reales de Chrome (CrUX API): p75 de los últimos 28 días.
// La clave se guarda solo en este equipo (settings.json, fuera de git) o llega por CRUX_API_KEY.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const endpoint = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
// Umbrales oficiales de Google: bueno hasta el primero, malo desde el segundo
const metrics = {
  lcp: { api: 'largest_contentful_paint', good: 2500, poor: 4000 },
  inp: { api: 'interaction_to_next_paint', good: 200, poor: 500 },
  cls: { api: 'cumulative_layout_shift', good: 0.1, poor: 0.25 },
  fcp: { api: 'first_contentful_paint', good: 1800, poor: 3000 },
  ttfb: { api: 'experimental_time_to_first_byte', good: 800, poor: 1800 }
};

export function createCrux(root) {
  const settingsFile = join(root, 'settings.json');
  const readSettings = () => readFile(settingsFile, 'utf-8').then(JSON.parse).catch(() => ({}));
  const apiKey = async () => process.env.CRUX_API_KEY || (await readSettings()).cruxApiKey || '';

  let last = 0;
  async function query(key, body) {
    // la API admite 150 consultas por minuto: se espacian a ~2,4 por segundo
    const wait = last + 420 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(`${endpoint}?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    if (res.status === 404) return null; // sin tráfico suficiente para tener datos
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || '';
      if (/API key not valid/i.test(msg)) throw Error('La clave de CrUX no es válida.');
      if (res.status === 403) throw Error('La API «Chrome UX Report API» no está habilitada en tu proyecto de Google Cloud, o la clave tiene restricciones que la bloquean.');
      if (res.status === 429) throw Error('Se ha superado el límite de consultas de CrUX. Prueba en un minuto.');
      throw Error(`CrUX respondió ${res.status}: ${msg}`);
    }
    return data.record;
  }
  const summarize = (record, scope) => record && {
    scope,
    period: record.collectionPeriod?.lastDate,
    metrics: Object.fromEntries(Object.entries(metrics).flatMap(([id, m]) => {
      const p75 = record.metrics?.[m.api]?.percentiles?.p75;
      if (p75 == null) return [];
      const v = Number(p75);
      return [[id, { p75: v, rating: v <= m.good ? 'good' : v <= m.poor ? 'needs' : 'poor' }]];
    }))
  };

  return {
    async status() { return { enabled: !!(await apiKey()), fromEnv: !!process.env.CRUX_API_KEY }; },
    async saveKey(value) {
      const key = String(value || '').trim();
      if (key) await query(key, { origin: 'https://www.google.com', formFactor: 'PHONE' }); // comprueba que funciona
      const settings = await readSettings();
      if (key) settings.cruxApiKey = key; else delete settings.cruxApiKey;
      await writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
    },
    // Consulta las URLs que falten y guarda el resultado junto a la auditoría (instantánea)
    async collect(dir, urls, formFactor) {
      const key = await apiKey();
      if (!key) throw Error('Añade tu clave de CrUX en Ajustes para ver datos de usuarios reales.');
      const file = join(dir, 'crux.json');
      const cache = await readFile(file, 'utf-8').then(JSON.parse).catch(() => ({ data: {} }));
      const device = formFactor === 'desktop' ? 'DESKTOP' : 'PHONE';
      const origins = {};
      for (const url of urls.filter(u => !(u in cache.data))) {
        let field = summarize(await query(key, { url, formFactor: device }), 'url');
        if (!field) {
          const origin = new URL(url).origin;
          origins[origin] ??= summarize(await query(key, { origin, formFactor: device }), 'origin');
          field = origins[origin];
        }
        cache.data[url] = field || null;
        await writeFile(file, JSON.stringify({ fetchedAt: new Date().toISOString(), formFactor: device, data: cache.data }), 'utf-8');
      }
      return cache.data;
    },
    async cached(dir) {
      return (await readFile(join(dir, 'crux.json'), 'utf-8').then(JSON.parse).catch(() => null))?.data || null;
    }
  };
}
