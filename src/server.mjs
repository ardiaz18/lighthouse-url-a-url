import http from 'node:http';
import { fork } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, relative, sep } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(join(root, '.env')); } catch {}
const runner = join(root, 'src', 'unlighthouse-runner.mjs');
const outputDir = join(root, '.unlighthouse');
const port = Number(process.env.PORT || 4173);
const firstAuditPort = 5678;
const maxRunning = 2;
const maxBytes = 12_000;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpeg': 'image/jpeg', '.json': 'application/json' };

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
// Análisis con Claude: envía el resumen priorizado y guarda la respuesta junto al informe
const analysisPrompt = `Eres consultor/a senior de SEO técnico y rendimiento web. Recibirás el resumen de una auditoría Lighthouse de varias URLs de un mismo sitio, ya ordenadas por gravedad.

Escribe en español, en Markdown, para un equipo de SEO y desarrollo:
1. Diagnóstico general en 3-5 frases.
2. Problemas agrupados por causa común (plantilla, recurso compartido, configuración del servidor), indicando a qué URLs afectan.
3. Plan de acción priorizado por impacto y esfuerzo: qué hacer, quién (SEO o desarrollo) y cómo comprobarlo.
4. URLs que conviene revisar primero y por qué.

Básate solo en los datos recibidos; si algo requiere comprobación adicional, dilo.`;
const analysisFile = key => {
  const dir = normalize(join(outputDir, key));
  if (!dir.startsWith(outputDir + sep)) throw Error('Ruta no válida');
  return join(dir, 'analisis-claude.md');
};
async function analyze(key, res) {
  if (!process.env.ANTHROPIC_API_KEY) throw Error('Falta la clave de la API de Claude. Crea un archivo .env en la carpeta del proyecto con ANTHROPIC_API_KEY=... y reinicia la herramienta.');
  const summary = await exportMarkdown(key);
  const client = new Anthropic();
  const stream = client.beta.messages.stream({
    model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
    max_tokens: 32000,
    output_config: { effort: 'high' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: analysisPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: summary }]
  });
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  let text = '';
  stream.on('text', chunk => { text += chunk; res.write(chunk); });
  try {
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') res.write('\n\n_Claude no ha podido completar el análisis._');
    if (text) await writeFile(analysisFile(key), text, 'utf-8');
  } catch (e) {
    res.write(`\n\nError al analizar: ${e.message}`);
  }
  res.end();
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
async function resultReports(key) {
  const dir = normalize(join(outputDir, key));
  if (!dir.startsWith(outputDir + sep)) throw Error('Ruta no válida');
  const reports = await Promise.all((await findReports(join(dir, 'reports'))).map(f => readReport(f).catch(() => null)));
  return reports.filter(Boolean).sort((a, b) => b.severity - a.severity || a.url.localeCompare(b.url));
}

// Gravedad: pérdida de puntuación ponderada (más peso a rendimiento y SEO)
const weights = { performance: 0.4, seo: 0.3, accessibility: 0.2, 'best-practices': 0.1 };
function priority(scores) {
  const values = Object.values(scores).filter(v => v != null);
  const severity = Math.round(Object.entries(weights).reduce((t, [id, w]) => t + w * (100 - (scores[id] ?? 100)), 0));
  const level = values.some(v => v < 50) || severity >= 25 ? 'alta' : values.some(v => v < 90) ? 'media' : 'baja';
  return { severity, level };
}
// Auditorías suspendidas, ordenadas por su peso en la categoría
function issues(lh) {
  const out = [];
  for (const cat of Object.values(lh.categories || {})) {
    for (const ref of cat.auditRefs || []) {
      const a = lh.audits?.[ref.id];
      if (!a || a.score == null || a.score >= 0.9 || ['informative', 'notApplicable', 'manual', 'error'].includes(a.scoreDisplayMode)) continue;
      out.push({ id: a.id, category: cat.id, title: a.title, value: a.displayValue || '', score: Math.round(a.score * 100), weight: ref.weight || 0 });
    }
  }
  return out.sort((a, b) => b.weight - a.weight || a.score - b.score);
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
  const lines = [
    `# Auditoría Lighthouse — ${key.split('/')[0]}`, '',
    `- Fecha: ${first.fetchTime ? new Date(first.fetchTime).toLocaleString('es-ES') : '—'}`,
    `- Dispositivo: ${first.formFactor === 'desktop' ? 'escritorio' : 'móvil'}`,
    `- URLs analizadas: ${reports.length}`, '',
    '> Instrucciones para Claude: actúa como consultor/a de SEO técnico y rendimiento web. Con estos datos de Lighthouse, explica los problemas principales, agrupa los que comparten causa (plantillas, recursos comunes), prioriza por impacto y esfuerzo y propón un plan de acción concreto, empezando por las URLs de prioridad alta.', '',
    '## Problemas repetidos en varias URLs', '',
    ...[...repeated.values()].sort((a, b) => b.urls - a.urls).slice(0, 20).map(e => `- [${catNames[e.category]}] ${e.title} — ${e.urls} URL${e.urls > 1 ? 's' : ''}`), '',
    '## URLs por prioridad', ''
  ];
  for (const r of reports) {
    lines.push(`### ${r.url}`, '', `Prioridad: **${levelNames[r.level]}** (gravedad ${r.severity}) · ` + Object.entries(catNames).map(([id, n]) => `${n} ${r.scores[id] ?? '–'}`).join(' · '), '');
    for (const i of r.issues.slice(0, 10)) lines.push(`- [${catNames[i.category]}] ${i.title}${i.value ? ` — ${i.value}` : ''} (puntuación ${i.score})`);
    lines.push('');
  }
  return lines.join('\n');
}
async function exportCsv(key) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['URL', 'Prioridad', 'Gravedad', ...Object.values(catNames), 'Problemas', 'Principales problemas']];
  for (const r of await resultReports(key)) rows.push([r.url, levelNames[r.level], r.severity, ...Object.keys(catNames).map(id => r.scores[id]), r.issues.length, r.issues.slice(0, 5).map(i => i.title).join(' | ')]);
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
      const name = `lighthouse-${exp[2].replace(/[^\w.-]+/g, '-')}.${exp[1]}`;
      res.writeHead(200, { 'Content-Type': (exp[1] === 'md' ? 'text/markdown' : 'text/csv') + '; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
      return res.end(exp[1] === 'md' ? await exportMarkdown(exp[2]) : await exportCsv(exp[2]));
    }
    const an = path.match(/^\/api\/analysis\/(.+)$/);
    if (an && req.method === 'POST') return await analyze(an[1], res);
    if (an && req.method === 'GET') return send(200, { text: await readFile(analysisFile(an[1]), 'utf-8').catch(() => null), ready: !!process.env.ANTHROPIC_API_KEY });
    if (req.method === 'GET' && path.startsWith('/api/results/')) return send(200, await resultReports(path.slice('/api/results/'.length)));
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
server.listen(port, '127.0.0.1', () => console.log(`Alicia Ruiz SEO Tools: http://127.0.0.1:${port}`));
