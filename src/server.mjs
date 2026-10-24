import http from 'node:http';
import { actions, metricSources } from './actions.mjs';
import { createCrux } from './crux.mjs';
import { fork } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, relative, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runner = join(root, 'src', 'unlighthouse-runner.mjs');
const outputDir = join(root, '.unlighthouse');
const port = Number(process.env.PORT || 4173);
const firstAuditPort = 5678;
const maxRunning = 2;
const maxBytes = 12_000;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpeg': 'image/jpeg', '.json': 'application/json' };

const crux = createCrux(root);
const collecting = new Map();
const audits = new Map();
let nextId = 1;

function validateUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Solo se admiten URLs http(s)');
  if (url.username || url.password) throw Error('No incluyas credenciales en la URL');
  return url.toString();
}
const list = v => String(v || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean).join(',');
const toKey = path => relative(outputDir, path).split(sep).join('/');

function freePort() {
  const used = new Set([...audits.values()].filter(a => a.running).map(a => a.port));
  let p = firstAuditPort; while (used.has(p)) p++; return p;
}

function startAudit(input) {
  if ([...audits.values()].filter(a => a.running).length >= maxRunning) throw Error(`Máximo ${maxRunning} auditorías simultáneas. Detén alguna antes.`);
  const site = validateUrl(input.site);
  // Mismas opciones que el CLI oficial: unlighthouse --site ... --mobile ...
  const args = ['--site', site, input.device === 'desktop' ? '--desktop' : '--mobile'];
  if (input.javascript) args.push('--enable-javascript');
  if (list(input.urls)) args.push('--urls', list(input.urls));
  if (list(input.exclude)) args.push('--exclude-urls', list(input.exclude));
  const audit = { id: nextId++, site, device: input.device === 'desktop' ? 'desktop' : 'mobile', port: freePort(), status: 'starting', running: true, key: null, api: null, startedAt: Date.now(), log: [], error: null };
  const child = fork(runner, args, { cwd: root, env: { ...process.env, UNLIGHTHOUSE_PORT: String(audit.port), NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const addLog = chunk => { audit.log.push(...String(chunk).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(Boolean)); audit.log = audit.log.slice(-200); };
  child.stdout.on('data', addLog);
  child.stderr.on('data', addLog);
  child.on('message', msg => {
    if (msg.type === 'ready') Object.assign(audit, { status: 'scanning', api: msg.api, site: msg.site || audit.site, key: toKey(msg.outputPath) });
    if (msg.type === 'finished') Object.assign(audit, { status: 'finished', seconds: msg.seconds });
    if (msg.type === 'error') audit.error = msg.message;
  });
  child.on('exit', code => {
    audit.running = false;
    if (audit.status !== 'finished') audit.status = code === 0 ? 'stopped' : 'failed';
  });
  audit.child = child;
  audits.set(audit.id, audit);
  return audit;
}

async function progress(audit) {
  if (!audit.api || !audit.running) return null;
  try {
    const { monitor } = await (await fetch(new URL('scan-meta', audit.api.replace(/\/?$/, '/')), { signal: AbortSignal.timeout(3000) })).json();
    return { done: monitor.doneTargets, total: monitor.allTargets };
  } catch { return null; }
}
const publicAudit = ({ child, api, log, ...a }) => a;

// Informes Lighthouse guardados en disco por Unlighthouse
const reportCache = new Map();
async function findReports(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory() && e.name !== '__screenshot-thumbnails__') found.push(...await findReports(full));
    else if (e.name === 'lighthouse.json') found.push(full);
  }
  return found;
}
async function readReport(file) {
  const { mtimeMs } = await stat(file);
  const hit = reportCache.get(file);
  if (hit?.mtimeMs === mtimeMs) return hit.data;
  const lh = JSON.parse(await readFile(file, 'utf-8'));
  const scores = Object.fromEntries(Object.values(lh.categories || {}).map(c => [c.id, c.score == null ? null : Math.round(c.score * 100)]));
  const data = {
    url: lh.finalDisplayedUrl || lh.finalUrl || lh.requestedUrl,
    fetchTime: lh.fetchTime,
    formFactor: lh.configSettings?.formFactor,
    scores,
    ...priority(scores),
    issues: issues(lh),
    report: '/informes/' + toKey(join(dirname(file), 'lighthouse.html')).split('/').map(encodeURIComponent).join('/')
  };
  reportCache.set(file, { mtimeMs, data });
  return data;
}
async function listResults() {
  const results = [];
  for (const host of await readdir(outputDir, { withFileTypes: true }).catch(() => [])) {
    if (!host.isDirectory()) continue;
    for (const run of await readdir(join(outputDir, host.name), { withFileTypes: true })) {
      const dir = join(outputDir, host.name, run.name);
      if (!run.isDirectory()) continue;
      const files = await findReports(join(dir, 'reports'));
      if (!files.length) continue;
      const first = await readReport(files[0]).catch(() => null);
      results.push({ key: toKey(dir), host: host.name.replace('꞉', ':'), count: files.length, formFactor: first?.formFactor, updated: (await stat(dir)).mtimeMs });
    }
  }
  return results.sort((a, b) => b.updated - a.updated);
}
function auditDir(key) {
  const dir = normalize(join(outputDir, key));
  if (!dir.startsWith(outputDir + sep)) throw Error('Ruta no válida');
  return dir;
}
async function resultReports(key) {
  const dir = auditDir(key);
  const reports = (await Promise.all((await findReports(join(dir, 'reports'))).map(f => readReport(f).catch(e => { console.error('No se pudo leer', f, e.message); return null; })))).filter(Boolean);
  // datos de usuarios reales: field queda undefined si aún no se han consultado y null si Google no tiene datos
  const field = await crux.cached(dir);
  const merged = reports.map(r => {
    if (!field || !(r.url in field)) return r;
    const f = field[r.url];
    return { ...r, field: f, ...priority(r.scores, f) };
  });
  return merged.sort((a, b) => b.severity - a.severity || a.url.localeCompare(b.url));
}
async function collectField(key) {
  // una sola consulta en curso por auditoría
  if (!collecting.has(key)) {
    const job = (async () => {
      const reports = await resultReports(key);
      await crux.collect(auditDir(key), reports.map(r => r.url), reports[0]?.formFactor);
    })().finally(() => collecting.delete(key));
    collecting.set(key, job);
  }
  return collecting.get(key);
}

// Gravedad: pérdida de puntuación ponderada (más peso a rendimiento y SEO)
const weights = { performance: 0.4, seo: 0.3, accessibility: 0.2, 'best-practices': 0.1 };
// Si hay datos reales de la propia URL, las Core Web Vitals suspendidas suben la gravedad
function priority(scores, field) {
  const values = Object.values(scores).filter(v => v != null);
  const vitals = field?.scope === 'url' ? ['lcp', 'inp', 'cls'].map(id => field.metrics[id]?.rating).filter(Boolean) : [];
  const severity = Math.round(Object.entries(weights).reduce((t, [id, w]) => t + w * (100 - (scores[id] ?? 100)), 0)
    + vitals.reduce((t, r) => t + (r === 'poor' ? 10 : r === 'needs' ? 4 : 0), 0));
  const level = values.some(v => v < 50) || vitals.includes('poor') || severity >= 25 ? 'alta' : values.some(v => v < 90) || vitals.includes('needs') ? 'media' : 'baja';
  return { severity, level };
}
// Auditorías suspendidas con qué hacer, por qué y dónde (recursos o elementos
// afectados, con su medida); ordenadas por impacto
const plain = text => String(text || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`/g, '');
function why(description) {
  const sentences = plain(description).split(/(?<=\.)\s+/).filter(s => !/^(Más información|Consulta|Obtén|Descubre|Learn more|More information)/i.test(s));
  return sentences.slice(0, 2).join(' ');
}
// Detalle útil que Lighthouse guarda en inglés dentro de cada elemento
function nodeNote(item) {
  const c = String(item.node?.explanation || '').match(/contrast of ([\d.]+) \(foreground color: (#\w+), background color: (#\w+)/);
  return c ? `contraste ${c[1].replace('.', ',')}:1, texto ${c[2]} sobre ${c[3]}` : '';
}
const shortUrl = u => { try { const x = new URL(u); return (x.host + x.pathname).replace(/^www\./, '').slice(0, 90); } catch { return String(u).slice(0, 90); } };
const kib = b => b >= 1024 ? Math.round(b / 1024) + ' KiB' : Math.round(b) + ' B';
const ms = v => `${Math.round(v)} ms`;
// Los «insights» guardan sus tablas dentro de una lista; los nodos sueltos también cuentan
function rows(details) {
  if (!details) return [];
  if (details.type === 'list') return details.items.flatMap(i => i.type === 'node' ? [{ node: i }] : rows(i));
  if (details.type === 'list-section') return rows(details.value);
  if (details.type === 'network-tree') return [{ chain: longestChain(details.chains) }];
  // las listas de comprobación traen un objeto: interesan las que no se cumplen
  if (details.type === 'checklist') return Object.values(details.items || {}).filter(c => c && c.value === false).map(c => ({ label: `No cumple: ${c.label}` }));
  return Array.isArray(details.items) ? details.items : [];
}
function longestChain(chains, path = []) {
  const next = Object.values(chains || {}).find(c => c.isLongest) || Object.values(chains || {})[0];
  return next ? longestChain(next.children, [...path, next]) : path;
}
function where(details, max = 5) {
  return rows(details).filter(item => item.node?.type !== 'text').slice(0, max).map(item => {
    if (item.chain) return item.chain.length ? `${item.chain.map(c => shortUrl(c.url)).join(' → ')} — ${ms(item.chain.at(-1).navStartToEndTime)}` : '';
    const node = item.node || item.source?.node;
    const url = item.url || item.source?.url || (typeof item.source === 'string' ? item.source : '');
    const label = node ? `${node.nodeLabel ? `«${String(node.nodeLabel).slice(0, 60)}» ` : ''}${node.selector ? `(${node.selector})` : ''}`.trim()
      : item.name && url ? `${item.name} (${shortUrl(url)})`
      : url ? shortUrl(url)
      : plain(item.label || item.reason || item.issueType || item.groupLabel || item.description || '').slice(0, 140);
    const measure = nodeNote(item)
      || (item.wastedMs ? ms(item.wastedMs) : item.wastedBytes ? kib(item.wastedBytes)
      : item.total ? `${ms(item.total)} de CPU` : item.totalBytes ? kib(item.totalBytes) : item.reflowTime ? `${ms(item.reflowTime)} recalculando` : item.duration ? ms(item.duration)
      : item.score ? `desplazamiento ${item.score.toFixed(3).replace('.', ',')}` : '');
    return label && (measure ? `${label} — ${measure}` : label);
  }).filter(Boolean);
}
const skipModes = ['informative', 'notApplicable', 'manual', 'error'];
function issues(lh) {
  const out = [];
  const add = (a, category, weight) => {
    const savingsMs = Object.values(a.metricSavings || {}).reduce((t, v) => t + (v || 0), 0);
    // las métricas no traen detalle: su «Dónde» sale de las auditorías que las causan
    const place = metricSources[a.id] ? metricSources[a.id].flatMap(id => where(lh.audits?.[id]?.details, 3)).slice(0, 6) : where(a.details);
    out.push({
      id: a.id, category, title: plain(a.title), value: a.displayValue || '', score: Math.round(a.score * 100),
      action: actions[a.id] || '', why: why(a.description), where: place,
      impact: weight + savingsMs / 200 + (1 - a.score)
    });
  };
  for (const cat of Object.values(lh.categories || {})) {
    for (const ref of cat.auditRefs || []) {
      const a = lh.audits?.[ref.id];
      if (!a || a.score == null || a.score >= 0.9 || skipModes.includes(a.scoreDisplayMode)) continue;
      add(a, cat.id, ref.weight || 0);
    }
  }
  // métricas que Lighthouse calcula pero no puntúa (Time to Interactive, Max Potential FID)
  for (const id of Object.keys(metricSources)) {
    const a = lh.audits?.[id];
    if (a && a.score != null && a.score < 0.9 && !out.some(i => i.id === id)) add(a, 'performance', 0);
  }
  return out.sort((a, b) => b.impact - a.impact);
}

const catNames = { performance: 'Rendimiento', accessibility: 'Accesibilidad', 'best-practices': 'Buenas prácticas', seo: 'SEO' };
const levelNames = { alta: 'Alta', media: 'Media', baja: 'Baja' };
async function exportMarkdown(key) {
  const reports = await resultReports(key);
  const first = reports[0] || {};
  const repeated = new Map();
  for (const r of reports) for (const i of r.issues) {
    const e = repeated.get(i.id) || { title: i.title, category: i.category, urls: 0 };
    e.urls++;
    repeated.set(i.id, e);
  }
  const originField = reports.find(r => r.field?.scope === 'origin')?.field;
  const lines = [
    `# Auditoría Lighthouse — ${key.split('/')[0]}`, '',
    `- Fecha: ${first.fetchTime ? new Date(first.fetchTime).toLocaleString('es-ES') : '—'}`,
    `- Dispositivo: ${first.formFactor === 'desktop' ? 'escritorio' : 'móvil'}`,
    `- URLs analizadas: ${reports.length}`,
    ...(originField ? fieldLine(originField).map(l => l.replace(', datos de todo el dominio: esta URL no tiene tráfico suficiente', ', todo el dominio')) : []), '',
    ...claudeBrief([
      'Haz un diagnóstico general del sitio en 3-5 frases.',
      'Agrupa los problemas por causa común (plantilla, plugin, recurso compartido, servidor) e indica a qué URLs afectan.',
      'Propón un plan de acción priorizado por impacto y esfuerzo: qué cambiar exactamente, quién lo hace (SEO, contenido o desarrollo) y cómo comprobar que está resuelto.',
      'Indica qué URLs revisar primero y por qué.'
    ]),
    '## Problemas repetidos en varias URLs', '',
    ...[...repeated.values()].sort((a, b) => b.urls - a.urls).slice(0, 20).map(e => `- [${catNames[e.category]}] ${e.title} — ${e.urls} URL${e.urls > 1 ? 's' : ''}`), '',
    '## URLs por prioridad', ''
  ];
  for (const r of reports) {
    lines.push(`### ${r.url}`, '', `Prioridad: **${levelNames[r.level]}** (gravedad ${r.severity}) · ` + Object.entries(catNames).map(([id, n]) => `${n} ${r.scores[id] ?? '–'}`).join(' · '), ...fieldLine(r.field, !!originField), '');
    lines.push(...issueLines(r.issues.slice(0, 10), 2), '');
  }
  return lines.join('\n');
}
// Petición para Claude al principio del .md: basta con soltar el archivo en una conversación
function claudeBrief(tasks) {
  return [
    '## Instrucciones para Claude', '',
    'Actúa como consultor/a senior de SEO técnico y rendimiento web. Este archivo contiene datos de Google Lighthouse exportados por la herramienta «Lighthouse completo URL a URL». Analízalos y responde en español:', '',
    ...tasks.map((t, n) => `${n + 1}. ${t}`), '',
    'Básate solo en los datos de este archivo; si algo requiere comprobarse en la web, dilo. «Qué hacer» y «Dónde» son pistas de la herramienta: concrétalas para este caso.',
    'Las puntuaciones de Lighthouse son de laboratorio (una carga simulada). Cuando haya datos de «Usuarios reales» (CrUX), dales prioridad: son las Core Web Vitals que Google usa como señal, y contrástalos con el laboratorio para explicar diferencias.', '',
    '---', ''
  ];
}
const ratingNames = { good: 'bueno', needs: 'mejorable', poor: 'malo' };
const fieldFormat = { lcp: v => `${(v / 1000).toFixed(1).replace('.', ',')} s`, inp: v => `${Math.round(v)} ms`, cls: v => v.toFixed(2).replace('.', ','), fcp: v => `${(v / 1000).toFixed(1).replace('.', ',')} s`, ttfb: v => `${(v / 1000).toFixed(1).replace('.', ',')} s` };
const fieldNames = { lcp: 'LCP', inp: 'INP', cls: 'CLS', fcp: 'FCP', ttfb: 'TTFB' };
function fieldLine(f, originShownAbove) {
  if (f === undefined) return [];
  if (!f) return ['- Usuarios reales (CrUX): Google no tiene datos suficientes de esta URL ni del dominio.'];
  if (f.scope === 'origin' && originShownAbove) return ['- Usuarios reales (CrUX): sin datos propios por falta de tráfico; ver el dato del dominio al principio.'];
  const values = Object.entries(f.metrics).map(([id, m]) => `${fieldNames[id]} ${fieldFormat[id](m.p75)} (${ratingNames[m.rating]})`).join(' · ');
  return [`- Usuarios reales (CrUX, percentil 75, 28 días${f.scope === 'origin' ? ', datos de todo el dominio: esta URL no tiene tráfico suficiente' : ''}): ${values}`];
}
function issueLines(list, maxWhere) {
  return list.flatMap(i => [
    `- [${catNames[i.category]}] **${i.title}**${i.value ? ` — ${i.value}` : ''}`,
    ...(i.action ? [`  - Qué hacer: ${i.action}`] : []),
    ...(i.why ? [`  - Por qué: ${i.why}`] : []),
    ...(i.where?.length ? [`  - Dónde: ${i.where.slice(0, maxWhere).join('; ')}`] : [])
  ]);
}
async function exportUrlMarkdown(key, url) {
  const r = (await resultReports(key)).find(x => x.url === url);
  if (!r) throw Error('URL no encontrada en esta auditoría');
  return [
    `# Informe Lighthouse — ${r.url}`, '',
    `- Fecha: ${r.fetchTime ? new Date(r.fetchTime).toLocaleString('es-ES') : '—'}`,
    `- Dispositivo: ${r.formFactor === 'desktop' ? 'escritorio' : 'móvil'}`,
    `- Prioridad: ${levelNames[r.level]} (gravedad ${r.severity})`,
    `- Puntuaciones: ` + Object.entries(catNames).map(([id, n]) => `${n} ${r.scores[id] ?? '–'}`).join(' · '),
    ...fieldLine(r.field), '',
    ...claudeBrief([
      'Explica en 2-3 frases el estado de la página.',
      'Para cada problema relevante, di exactamente qué cambiar, en qué recurso o elemento (usa los datos de «Dónde»), quién lo hace (SEO, contenido o desarrollo) y cómo comprobar que está resuelto.',
      'Ordena las tareas por impacto y esfuerzo, empezando por las victorias rápidas.'
    ]),
    '## Problemas ordenados por impacto', '',
    ...issueLines(r.issues, 5)
  ].join('\n');
}
async function exportCsv(key) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const vitals = ['lcp', 'inp', 'cls'];
  const rows = [['URL', 'Prioridad', 'Gravedad', ...Object.values(catNames), ...vitals.map(id => `${fieldNames[id]} real (p75)`), 'Datos reales de', 'Problemas', 'Principales problemas']];
  for (const r of await resultReports(key)) rows.push([r.url, levelNames[r.level], r.severity, ...Object.keys(catNames).map(id => r.scores[id]),
    ...vitals.map(id => r.field?.metrics[id] ? `${fieldFormat[id](r.field.metrics[id].p75)} (${ratingNames[r.field.metrics[id].rating]})` : ''),
    r.field ? (r.field.scope === 'url' ? 'URL' : 'Dominio') : r.field === null ? 'Sin datos' : '',
    r.issues.length, r.issues.slice(0, 5).map(i => i.title).join(' | ')]);
  return '﻿' + rows.map(r => r.map(q).join(';')).join('\r\n');
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > maxBytes) throw Error('Solicitud demasiado grande'); }
  return JSON.parse(body || '{}');
}
async function sendFile(res, base, path) {
  const file = normalize(join(base, path));
  if (!file.startsWith(base + sep)) return false;
  const body = await readFile(file).catch(() => null);
  if (!body) return false;
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
  res.end(body);
  return true;
}

const server = http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const { pathname } = new URL(req.url, 'http://x');
  const path = decodeURIComponent(pathname);
  try {
    if (req.method === 'GET' && (path === '/' || path.startsWith('/assets/'))) {
      if (await sendFile(res, join(root, 'public'), path === '/' ? 'index.html' : path)) return;
      return send(404, { error: 'No encontrado' });
    }
    if (req.method === 'GET' && path.startsWith('/informes/') && path.endsWith('/lighthouse.html')) {
      if (await sendFile(res, outputDir, path.slice('/informes/'.length))) return;
      return send(404, { error: 'Informe no encontrado' });
    }
    if (req.method === 'GET' && path === '/api/audits') {
      return send(200, await Promise.all([...audits.values()].reverse().map(async a => ({ ...publicAudit(a), progress: await progress(a) }))));
    }
    if (req.method === 'POST' && path === '/api/audits') return send(201, publicAudit(startAudit(await readJson(req))));
    if (req.method === 'GET' && path === '/api/results') return send(200, await listResults());
    const exp = path.match(/^\/api\/export\/(md|csv)\/(.+)$/);
    if (req.method === 'GET' && exp) {
      const pageUrl = new URL(req.url, 'http://x').searchParams.get('url');
      const body = exp[1] === 'csv' ? await exportCsv(exp[2]) : pageUrl ? await exportUrlMarkdown(exp[2], pageUrl) : await exportMarkdown(exp[2]);
      const name = `lighthouse-${(pageUrl ? shortUrl(pageUrl) : exp[2]).replace(/[^\w.-]+/g, '-').replace(/-+$/, '')}.${exp[1]}`;
      res.writeHead(200, { 'Content-Type': (exp[1] === 'md' ? 'text/markdown' : 'text/csv') + '; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
      return res.end(body);
    }
    if (req.method === 'GET' && path.startsWith('/api/results/')) return send(200, await resultReports(path.slice('/api/results/'.length)));
    if (req.method === 'POST' && path.startsWith('/api/field/')) { await collectField(path.slice('/api/field/'.length)); return send(200, { ok: true }); }
    if (req.method === 'GET' && path === '/api/settings') return send(200, { crux: await crux.status() });
    if (req.method === 'POST' && path === '/api/settings') { await crux.saveKey((await readJson(req)).cruxApiKey); return send(200, { crux: await crux.status() }); }
    const m = path.match(/^\/api\/audits\/(\d+)(\/stop|\/log)$/);
    const audit = m && audits.get(Number(m[1]));
    if (audit && req.method === 'GET' && m[2] === '/log') return send(200, audit.log);
    if (audit && req.method === 'POST' && m[2] === '/stop') {
      if (audit.running) { audit.child.send('stop'); setTimeout(() => audit.running && audit.child.kill(), 5000); }
      return send(200, { ok: true });
    }
    send(404, { error: 'No encontrado' });
  } catch (e) { send(400, { error: e.message }); }
});

const stopAll = () => { for (const a of audits.values()) if (a.running) a.child.kill(); process.exit(0); };
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
server.listen(port, '127.0.0.1', () => console.log(`Lighthouse completo URL a URL: http://127.0.0.1:${port}`));
