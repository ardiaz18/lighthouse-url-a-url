// Datos de usuarios reales de Chrome (CrUX API): p75 de los últimos 28 días.
// La clave se guarda solo en este equipo (settings.json, fuera de git) o llega por CRUX_API_KEY.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const version = 2;
const endpoint = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const historyEndpoint = 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord';
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
  async function query(key, body, url = endpoint) {
    // la API admite 150 consultas por minuto: se espacian a ~2,4 por segundo
    const wait = last + 420 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(`${url}?key=${encodeURIComponent(key)}`, {
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
      const cache = await this.cached(dir).then(data => ({ data: data || {} }));
      const device = formFactor === 'desktop' ? 'DESKTOP' : 'PHONE';
      const origins = {};
      for (const url of urls.filter(u => !(u in cache.data))) {
        // URL en el mismo dispositivo → URL sumando todos los dispositivos → dominio
        let field = summarize(await query(key, { url, formFactor: device }), 'url')
          || summarize(await query(key, { url }), 'url-all');
        if (!field) {
          const origin = new URL(url).origin;
          origins[origin] ??= summarize(await query(key, { origin, formFactor: device }), 'origin');
          field = origins[origin];
        }
        cache.data[url] = field || null;
        await writeFile(file, JSON.stringify({ version, fetchedAt: new Date().toISOString(), formFactor: device, data: cache.data }), 'utf-8');
      }
      return cache.data;
    },
    // Evolución semanal (ventanas de 28 días) de LCP, INP y CLS del dominio: últimos ~6 meses.
    // Google la actualiza cada semana: se guarda con la auditoría y se refresca a los 3 días.
    async history(dir, origin, formFactor) {
      const file = join(dir, 'crux-history.json');
      const cache = await readFile(file, 'utf-8').then(JSON.parse).catch(() => null);
      if (cache && Date.now() - new Date(cache.fetchedAt) < 3 * 864e5) return cache.data;
      const key = await apiKey();
      if (!key) return null;
      const device = formFactor === 'desktop' ? 'DESKTOP' : 'PHONE';
      const record = await query(key, { origin, formFactor: device, metrics: ['lcp', 'inp', 'cls'].map(id => metrics[id].api), collectionPeriodCount: 25 }, historyEndpoint);
      const date = d => d && `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
      const data = record && {
        origin, formFactor: device,
        periods: (record.collectionPeriods || []).map(p => date(p.lastDate)),
        series: Object.fromEntries(['lcp', 'inp', 'cls'].map(id => [id, (record.metrics?.[metrics[id].api]?.percentilesTimeseries?.p75s || []).map(v => v == null || v === 'NaN' ? null : Number(v))]))
      };
      await writeFile(file, JSON.stringify({ fetchedAt: new Date().toISOString(), data }), 'utf-8');
      return data;
    },
    // Usuarios reales de tu dominio frente a los de la competencia (dato actual de 28 días)
    async benchmark(dir, own, domains, formFactor) {
      const key = await apiKey();
      if (!key) throw Error('Añade tu clave de CrUX en Ajustes para comparar con la competencia.');
      const device = formFactor === 'desktop' ? 'DESKTOP' : 'PHONE';
      const results = [];
      for (const d of [own, ...domains]) {
        const host = String(d).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
        if (!host || results.some(r => r.domain === host)) continue;
        // si no hay datos con www o sin www, se prueba la otra variante
        const variants = host.startsWith('www.') ? [host, host.slice(4)] : [host, 'www.' + host];
        let field = null, origin = 'https://' + variants[0];
        for (const v of variants) {
          field = summarize(await query(key, { origin: 'https://' + v, formFactor: device }), 'origin');
          if (field) { origin = 'https://' + v; break; }
        }
        results.push({ domain: host, origin, own: results.length === 0, field });
      }
      const data = { formFactor: device, fetchedAt: new Date().toISOString(), domains: domains, results };
      await writeFile(join(dir, 'benchmark.json'), JSON.stringify(data), 'utf-8');
      return data;
    },
    savedBenchmark: dir => readFile(join(dir, 'benchmark.json'), 'utf-8').then(JSON.parse).catch(() => null),
    async cached(dir) {
      const cache = await readFile(join(dir, 'crux.json'), 'utf-8').then(JSON.parse).catch(() => null);
      if (!cache?.data) return null;
      // versiones anteriores no probaban «todos los dispositivos»: esas URLs se vuelven a consultar
      if (cache.version !== version) for (const [url, f] of Object.entries(cache.data)) if (!f || f.scope === 'origin') delete cache.data[url];
      return cache.data;
    }
  };
}
