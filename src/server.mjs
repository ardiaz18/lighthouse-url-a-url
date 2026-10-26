import http from 'node:http';
import { actions, metricSources } from './actions.mjs';
import { createCrux } from './crux.mjs';
import { createRender } from './render.mjs';
import { createGsc, fetchStates, indexingStates } from './gsc.mjs';
import { googleClient } from './google-client.mjs';
import { fork } from 'node:child_process';
import { readFile, readdir, stat, writeFile, rm, rmdir } from 'node:fs/promises';
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
const render = createRender();
const gsc = createGsc(root);
// builtIn: la herramienta trae su propio cliente OAuth y basta con el botón de conectar
const gscStatus = async () => ({ ...await gsc.status(), builtIn: !!await googleClient(root) });
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
  if (input.allUrls) args.push('--disable-dynamic-sampling');
  // con rutas manuales Unlighthouse no rastrea ni muestrea
  const options = { sampling: !input.allUrls && !list(input.urls), manualUrls: !!list(input.urls), render: !!input.render };
  const audit = { id: nextId++, site, device: input.device === 'desktop' ? 'desktop' : 'mobile', port: freePort(), status: 'starting', running: true, key: null, api: null, startedAt: Date.now(), log: [], error: null };
  const child = fork(runner, args, { cwd: root, env: { ...process.env, UNLIGHTHOUSE_PORT: String(audit.port), NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const addLog = chunk => { audit.log.push(...String(chunk).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(Boolean)); audit.log = audit.log.slice(-200); };
  child.stdout.on('data', addLog);
  child.stderr.on('data', addLog);
  child.on('message', msg => {
    if (msg.type === 'ready') {
      Object.assign(audit, { status: 'scanning', api: msg.api, site: msg.site || audit.site, key: toKey(msg.outputPath) });
      writeFile(join(msg.outputPath, 'audit-options.json'), JSON.stringify(options), 'utf-8').catch(() => {});
    }
    if (msg.type === 'finished') Object.assign(audit, { status: 'finished', seconds: msg.seconds });
    if (msg.type === 'error') audit.error = msg.message;
  });
  child.on('exit', code => {
    audit.running = false;
    // la comprobación de renderizado empieza al terminar, para no falsear las mediciones de Lighthouse
    if (options.render && audit.key && audit.status === 'finished') {
      audit.rendering = true;
      collectRender(audit.key).catch(e => { audit.error = 'Renderizado para Google: ' + e.message; }).finally(() => { audit.rendering = false; });
    }
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
  Object.defineProperty(data, 'requests', { value: (lh.audits?.['network-requests']?.details?.items || []).map(i => ({ url: i.url, resourceType: i.resourceType })) });
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
      const options = await readFile(join(dir, 'audit-options.json'), 'utf-8').then(JSON.parse).catch(() => ({}));
      const hasRender = await stat(join(dir, 'render.json')).then(() => true, () => false);
      results.push({ key: toKey(dir), host: host.name.replace('꞉', ':'), count: files.length, formFactor: first?.formFactor, sampling: options.sampling, render: !!options.render || hasRender, updated: (await stat(dir)).mtimeMs });
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
  const rendered = await render.cached(dir);
  const google = await gsc.cached(dir);
  const merged = reports.map(r => {
    const f = field && r.url in field ? field[r.url] : undefined;
    const g = rendered?.[r.url] && { status: rendered[r.url].status, error: rendered[r.url].error, findings: rendered[r.url].findings };
    const q = google?.[r.url] && { ...google[r.url], status: googleStatus(google[r.url]) };
    if (f === undefined && !g && !q) return r;
    return { ...r, ...(f !== undefined && { field: f }), ...(q && { google: q }), ...(g && { render: g }),
      issues: [...(q ? googleIssues(q) : []), ...(g ? renderIssues(g) : []), ...r.issues], ...priority(r.scores, f, g?.status, q?.status) };
  });
  return merged.sort((a, b) => b.severity - a.severity || a.url.localeCompare(b.url));
}
// Avisos de renderizado como problemas de la lista, con su «qué hacer»
// Search Console: estado real de cada URL en Google
const googleNames = { indexed: 'Indexada', notIndexed: 'No indexada', blocked: 'Google no pudo descargarla', noAccess: 'Sin acceso en Search Console', error: 'Error al consultar' };
function googleStatus(q) {
  if (q.noAccess) return 'noAccess';
  if (q.error) return 'error';
  if (q.fetch && q.fetch !== 'SUCCESSFUL' && q.fetch !== 'PAGE_FETCH_STATE_UNSPECIFIED') return 'blocked';
  return q.verdict === 'PASS' ? 'indexed' : 'notIndexed';
}
function googleIssues(q) {
  const out = [], add = (level, title, value, action, where = []) => out.push({ id: 'google:' + title, category: 'google', title, value, action, why: '', where, score: level === 'problema' ? 0 : 50, impact: level === 'problema' ? 45 : 15 });
  if (q.status === 'blocked') add('problema', 'Googlebot no pudo descargarla en su último rastreo', fetchStates[q.fetch] || q.fetch,
    q.fetch === 'ACCESS_FORBIDDEN' || q.fetch === 'ACCESS_DENIED' ? 'El servidor, el firewall o la CDN (Cloudflare, Wordfence, el hosting…) rechaza a Googlebot. Revisa las reglas de bloqueo por bots, país o IP y permite el user-agent y los rangos de IP oficiales de Googlebot. Después, solicita la indexación en Search Console.'
    : q.fetch === 'SERVER_ERROR' ? 'El servidor falló cuando Google la visitó (5xx). Revisa los registros del servidor, la carga del hosting y los límites de peticiones; si se repite, Google rastreará menos el sitio.'
    : 'Corrige la causa indicada y solicita de nuevo la indexación en la Inspección de URLs de Search Console.');
  if (q.status === 'notIndexed') add('problema', 'Google no la tiene indexada', q.coverage || 'Sin indexar',
    /noindex|excluida/i.test(q.coverage || '') ? 'Si debe posicionar, quita el noindex y solicita la indexación.'
    : /rastreada/i.test(q.coverage || '') ? 'Google la conoce y la ha rastreado pero decidió no indexarla: suele indicar contenido poco útil, duplicado o débil frente a otras URLs del sitio. Mejora el contenido y el enlazado interno, y revisa que no compita con otra URL.'
    : /descubierta|desconocida/i.test(q.coverage || '') ? 'Google aún no la ha rastreado. Enlázala desde páginas importantes, inclúyela en el sitemap y solicita la indexación.'
    : 'Revisa el motivo en la Inspección de URLs de Search Console y solicita la indexación cuando esté corregido.');
  if (q.indexing && indexingStates[q.indexing]) add('aviso', 'Google detecta un bloqueo de indexación', indexingStates[q.indexing], 'Si la URL debe posicionar, quita ese bloqueo. Si es intencionado, ignora este aviso.');
  if (q.googleCanonical && q.userCanonical && q.googleCanonical !== q.userCanonical) add('aviso', 'Google ha elegido otra canonical', `Tuya: ${q.userCanonical} · Google: ${q.googleCanonical}`, 'Google ignora tu canonical y prefiere otra URL. Revisa si las dos tienen el mismo contenido, unifica enlaces internos y sitemap hacia la versión que quieres y comprueba redirecciones.');
  return out;
}
const renderNames = { ok: 'Correcto', aviso: 'Revisar', problema: 'Problema', error: 'No se pudo comprobar' };
function renderIssues(g) {
  return g.findings.map(f => ({
    id: 'render:' + f.title, category: 'render', title: f.title, value: f.value, score: f.level === 'problema' ? 0 : 50,
    action: renderActions[f.title] || '', why: '', where: f.where || [], impact: f.level === 'problema' ? 40 : 15
  }));
}
const renderActions = {
  'La URL responde con un error HTTP': 'Corrige el error del servidor o, si la página ya no existe, redirígela con un 301 a la URL equivalente y actualiza los enlaces internos que apuntan aquí.',
  'Bloqueada para indexación por la cabecera X-Robots-Tag': 'El servidor envía X-Robots-Tag: noindex (suele venir del hosting, de reglas en .htaccess o de un plugin de seguridad o SEO). Si la página debe posicionar, quita esa cabecera; si es intencionado, ignora este aviso.',
  'La página tiene noindex': 'Si la página debe posicionar, quita el noindex (en WordPress suele estar en el plugin SEO de la propia página o en «Ajustes → Lectura → Disuadir a los motores de búsqueda»). Si es intencionado, ignora este aviso.',
  'La canonical apunta a otra URL': 'Si esta URL es la que debe posicionar, haz que su canonical apunte a sí misma. Si de verdad es un duplicado, está bien; en ese caso evita enlazarla internamente y sácala del sitemap.',
  'La URL está bloqueada para Googlebot en robots.txt': 'Si la URL debe posicionar, quita o ajusta la regla Disallow indicada en robots.txt. Si no debe indexarse, usa noindex en lugar de bloquearla (si está bloqueada, Google no puede ver el noindex).',
  'Recursos del propio sitio bloqueados por robots.txt': 'Tu robots.txt impide a Googlebot descargar los archivos indicados en «Dónde», y sin ellos Google puede ver la página rota o sin contenido. Quita o ajusta la regla Disallow que aparece junto a cada uno (p. ej. añade «Allow: /wp-content/» o «Allow: /*.js» y «Allow: /*.css»).',
  'robots.txt no disponible': 'Haz que /robots.txt responda con 200 (o 404 si no lo usas). Si responde con error 5xx, Google puede dejar de rastrear el sitio temporalmente.',
  'La meta robots cambia con JavaScript': 'Pon la meta robots definitiva en el HTML que envía el servidor. Si el HTML inicial lleva noindex, Google puede no llegar a renderizar la página y la descarta aunque el JavaScript lo quite.',
  'La canonical solo aparece con JavaScript': 'Incluye la canonical en el HTML que envía el servidor (desde el plugin SEO o la plantilla), no la añadas con JavaScript o con Tag Manager.',
  'La canonical cambia con JavaScript': 'Deja una sola canonical, la correcta, en el HTML del servidor y quita el script que la modifica. Si las dos versiones no coinciden, Google puede ignorar ambas.',
  'El título solo aparece con JavaScript': 'Genera el <title> en el servidor (plantilla o plugin SEO) para que esté en el HTML inicial.',
  'El H1 solo aparece con JavaScript': 'Haz que el H1 esté en el HTML que envía el servidor; revisa si lo pinta un bloque, slider o widget que carga con JavaScript.',
  'Enlaces internos que solo aparecen con JavaScript': 'Haz que el menú y los enlaces importantes estén en el HTML del servidor como <a href>. Si los genera JavaScript (menús, widgets, «cargar más»), Google los descubre más tarde o no los descubre.',
  'Contenido que solo aparece al interactuar': 'Los bloques de «Dónde» están invisibles hasta que el usuario hace scroll o mueve el ratón, y Googlebot no interactúa: los verá en blanco y puede darles menos peso o no tenerlos en cuenta. Causa habitual: un plugin de optimización (WP Rocket, LiteSpeed Cache, Perfmatters…) con «Retrasar JavaScript hasta la interacción» activo junto con animaciones de entrada; excluye de ese retraso el JavaScript del constructor (p. ej. elementor-frontend y sus animaciones) o desactiva la animación de entrada en el contenido importante (en Elementor: Avanzado → Efectos de movimiento → Animación de entrada: Ninguna). Si quieres confirmarlo, en la Inspección de URLs de Search Console la captura saldrá con esos bloques en blanco.',
  'Contenido invisible por CSS aunque se interactúe': 'El texto de «Dónde» está en la página pero invisible (opacity:0 o visibility:hidden) incluso al hacer scroll: suele ser un carrusel o texto rotativo (solo se ve uno cada vez), una pestaña o un efecto al pasar el ratón. Google solo verá la parte visible en su captura. Si es contenido importante, muéstralo de forma estática.',
  'Mucho contenido principal oculto (display:none)': 'Gran parte del texto está en pestañas, acordeones o bloques plegados. Google suele indexarlo, pero lo más importante (lo que responde a la búsqueda) debería estar visible al cargar. Asegúrate de que el contenido clave está visible al cargar.',
  'Texto que solo aparece con JavaScript':'Haz que el contenido principal esté en el HTML que envía el servidor (renderizado en servidor o HTML estático). Si depende de JavaScript, su indexación depende de que Google renderice bien la página. Si es intencionado, compruébalo en la Inspección de URLs de Search Console.'
};
async function collectRender(key, force) {
  if ([...audits.values()].some(a => a.running && a.key === key)) throw Error('Espera a que termine la auditoría: comprobar el renderizado a la vez falsearía las mediciones de rendimiento.');
  if (!collecting.has('render:' + key)) {
    const job = (async () => {
      const dir = auditDir(key);
      const reports = await Promise.all((await findReports(join(dir, 'reports'))).map(f => readReport(f).catch(() => null)));
      await render.collect(dir, reports.filter(Boolean), force);
    })().finally(() => collecting.delete('render:' + key));
    collecting.set('render:' + key, job);
  }
  return collecting.get('render:' + key);
}
// Borra una auditoría guardada (informes, datos reales, renderizado y Search Console)
async function deleteAudit(key) {
  const dir = auditDir(key);
  if ([...audits.values()].some(a => (a.running || a.rendering) && a.key === key) || [...collecting.keys()].some(k => k.endsWith(key)))
    throw Error('Esta auditoría está en curso o consultando datos. Espera a que termine o detenla antes de borrarla.');
  await rm(dir, { recursive: true, force: true });
  await rmdir(dirname(dir)).catch(() => {}); // la carpeta del dominio, si se ha quedado vacía
  for (const file of reportCache.keys()) if (file.startsWith(dir + sep)) reportCache.delete(file);
  for (const a of audits.values()) if (a.key === key) audits.delete(a.id);
}
// Antes y después: compara dos auditorías URL a URL (puntuaciones, problemas y usuarios reales)
async function compareAudits(beforeKey, afterKey) {
  const [A, B] = await Promise.all([resultReports(beforeKey), resultReports(afterKey)]);
  const norm = u => u.replace(/\/$/, '');
  const byUrl = new Map(A.map(r => [norm(r.url), r]));
  const cats = Object.keys(scoreNames);
  const vital = (r, id) => r?.field && r.field.scope !== 'origin' ? r.field.metrics[id]?.p75 ?? null : null;
  // solo se comparan los problemas de comprobaciones que existan en las dos auditorías
  const both = cat => cat === 'render' ? A.some(r => r.render) && B.some(r => r.render) : cat === 'google' ? A.some(r => r.google) && B.some(r => r.google) : true;
  // el rendimiento de laboratorio varía ±5-10 puntos entre ejecuciones: por debajo de eso es ruido
  const threshold = id => id === 'performance' ? 10 : 5;
  const rows = [], resolved = new Map(), appeared = new Map();
  for (const b of B) {
    const a = byUrl.get(norm(b.url));
    byUrl.delete(norm(b.url));
    const delta = Object.fromEntries(cats.map(id => [id, a && a.scores[id] != null && b.scores[id] != null ? b.scores[id] - a.scores[id] : null]));
    const ids = r => new Map((r?.issues || []).filter(i => both(i.category)).map(i => [i.id, i]));
    const before = ids(a), after = ids(b);
    const fixed = [...before.values()].filter(i => !after.has(i.id)), added = [...after.values()].filter(i => !before.has(i.id));
    if (a) { fixed.forEach(i => resolved.set(i.id, { title: i.title, category: i.category, urls: (resolved.get(i.id)?.urls || 0) + 1 })); added.forEach(i => appeared.set(i.id, { title: i.title, category: i.category, urls: (appeared.get(i.id)?.urls || 0) + 1 })); }
    const up = cats.some(id => delta[id] != null && delta[id] >= threshold(id)), down = cats.some(id => delta[id] != null && delta[id] <= -threshold(id));
    const trend = !a ? 'nueva' : down && !up ? 'peor' : up && !down ? 'mejor' : up && down ? 'mixta' : 'igual';
    rows.push({ url: b.url, trend, before: a && { scores: a.scores, level: a.level, issues: a.issues.length, lcp: vital(a, 'lcp'), inp: vital(a, 'inp'), cls: vital(a, 'cls') },
      after: { scores: b.scores, level: b.level, issues: b.issues.length, lcp: vital(b, 'lcp'), inp: vital(b, 'inp'), cls: vital(b, 'cls') }, delta,
      fixed: fixed.map(i => i.title), added: added.map(i => i.title), report: b.report, beforeReport: a?.report });
  }
  for (const a of byUrl.values()) rows.push({ url: a.url, trend: 'eliminada', before: { scores: a.scores, level: a.level, issues: a.issues.length }, after: null, delta: {}, fixed: [], added: [] });
  const common = rows.filter(r => r.before && r.after);
  const avg = (side, id) => { const v = common.map(r => r[side].scores[id]).filter(x => x != null); return v.length ? Math.round(v.reduce((t, x) => t + x, 0) / v.length) : null; };
  const order = { peor: 0, mixta: 1, mejor: 2, igual: 3, nueva: 4, eliminada: 5 };
  rows.sort((x, y) => order[x.trend] - order[y.trend] || (x.delta.performance ?? 0) - (y.delta.performance ?? 0));
  const meta = key => key.split('/')[0];
  // saldo neto por problema: si desaparece de unas URLs y aparece en otras, cuenta la diferencia
  for (const [id, r] of resolved) {
    const n = r.urls - (appeared.get(id)?.urls || 0);
    if (n > 0) { r.urls = n; appeared.delete(id); } else { resolved.delete(id); if (n < 0) appeared.get(id).urls = -n; else appeared.delete(id); }
  }
  const top = m => [...m.values()].sort((x, y) => y.urls - x.urls).slice(0, 15);
  const date = rs => rs[0]?.fetchTime || null;
  return {
    before: { key: beforeKey, date: date(A), count: A.length }, after: { key: afterKey, date: date(B), count: B.length }, host: meta(afterKey),
    averages: Object.fromEntries(cats.map(id => [id, { before: avg('before', id), after: avg('after', id) }])),
    counts: Object.fromEntries(Object.keys(order).map(t => [t, rows.filter(r => r.trend === t).length])),
    skipped: ['render', 'google'].filter(c => !both(c)).map(c => catNames[c]),
    resolved: top(resolved), appeared: top(appeared), rows
  };
}
async function exportCompareMarkdown(beforeKey, afterKey) {
  const c = await compareAudits(beforeKey, afterKey);
  const d = s => s ? new Date(s).toLocaleDateString('es-ES') : '—';
  const sign = v => v == null ? '–' : (v > 0 ? '+' : '') + v;
  const lines = [
    `# Antes y después — ${c.host}`, '',
    `- Antes: auditoría del ${d(c.before.date)} (${c.before.count} URLs)`,
    `- Después: auditoría del ${d(c.after.date)} (${c.after.count} URLs)`, '',
    ...claudeBrief([
      'Resume en 3-5 frases qué ha mejorado y qué ha empeorado entre las dos auditorías.',
      'Explica las causas probables de los empeoramientos usando los problemas nuevos, y qué falta por resolver.',
      'Redacta un párrafo breve, en lenguaje no técnico, para enviar al cliente con los resultados del trabajo realizado.'
    ]),
    '## Media de puntuaciones (URLs presentes en las dos auditorías)', '',
    ...Object.entries(scoreNames).map(([id, n]) => `- ${n}: ${c.averages[id].before ?? '–'} → ${c.averages[id].after ?? '–'} (${sign(c.averages[id].after != null && c.averages[id].before != null ? c.averages[id].after - c.averages[id].before : null)})`), '',
    `URLs que mejoran: ${c.counts.mejor} · empeoran: ${c.counts.peor} · mixtas: ${c.counts.mixta} · iguales: ${c.counts.igual} · nuevas: ${c.counts.nueva} · ya no aparecen: ${c.counts.eliminada}`, '',
    'Nota: el rendimiento de laboratorio de Lighthouse varía unos ±5-10 puntos entre ejecuciones sin que cambie la web; aquí solo cuenta como mejora o empeoramiento un cambio de 10 puntos o más en Rendimiento (5 en el resto). Si hay URLs «nuevas» o que «ya no aparecen», probablemente se deba al muestreo de URLs.', '',
    '## Problemas resueltos', '', ...(c.resolved.length ? c.resolved.map(i => `- [${catNames[i.category]}] ${i.title} — ${i.urls} URL${i.urls > 1 ? 's' : ''}`) : ['- Ninguno']), '',
    '## Problemas nuevos', '', ...(c.appeared.length ? c.appeared.map(i => `- [${catNames[i.category]}] ${i.title} — ${i.urls} URL${i.urls > 1 ? 's' : ''}`) : ['- Ninguno']), '',
    '## URLs', ''
  ];
  for (const r of c.rows) {
    const scores = Object.entries(scoreNames).map(([id, n]) => `${n} ${r.before?.scores[id] ?? '–'}→${r.after?.scores[id] ?? '–'}`).join(' · ');
    lines.push(`- ${r.url} — **${r.trend}** · ${scores}${r.fixed.length ? ` · resueltos: ${r.fixed.slice(0, 5).join('; ')}` : ''}${r.added.length ? ` · nuevos: ${r.added.slice(0, 5).join('; ')}` : ''}`);
  }
  return lines.join('\n');
}
// Limpia el registro completo (no toca claves ni conexiones, que están en settings.json)
async function deleteAllAudits() {
  if ([...audits.values()].some(a => a.running || a.rendering) || collecting.size) throw Error('Hay una auditoría en curso o consultando datos. Espera a que termine o detenla antes de limpiar el registro.');
  const results = await listResults();
  for (const r of results) await deleteAudit(r.key);
  for (const a of audits.values()) if (!a.running) audits.delete(a.id);
  return results.length;
}
async function collectGoogle(key) {
  if (!collecting.has('google:' + key)) {
    const job = (async () => {
      const reports = await resultReports(key);
      await gsc.collect(auditDir(key), reports.map(r => r.url));
    })().finally(() => collecting.delete('google:' + key));
    collecting.set('google:' + key, job);
  }
  return collecting.get('google:' + key);
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
// Un problema de renderizado para Google sube la prioridad (indexación en riesgo)
function priority(scores, field, renderStatus, googleStatus) {
  const values = Object.values(scores).filter(v => v != null);
  const vitals = field && field.scope !== 'origin' ?['lcp', 'inp', 'cls'].map(id => field.metrics[id]?.rating).filter(Boolean) : [];
  const severity = Math.round(Object.entries(weights).reduce((t, [id, w]) => t + w * (100 - (scores[id] ?? 100)), 0)
    + vitals.reduce((t, r) => t + (r === 'poor' ? 10 : r === 'needs' ? 4 : 0), 0)
    + (renderStatus === 'problema' ? 15 : renderStatus === 'aviso' ? 5 : 0)
    + (googleStatus === 'notIndexed' || googleStatus === 'blocked' ? 20 : 0));
  const level = values.some(v => v < 50) || vitals.includes('poor') || renderStatus === 'problema' || googleStatus === 'notIndexed' || googleStatus === 'blocked' || severity >= 25 ? 'alta' : values.some(v => v < 90) || vitals.includes('needs') ? 'media' : 'baja';
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

const scoreNames = { performance: 'Rendimiento', accessibility: 'Accesibilidad', 'best-practices': 'Buenas prácticas', seo: 'SEO' };
const catNames = { ...scoreNames, render: 'Renderizado para Google', google: 'Google (Search Console)' };
const levelNames = { alta: 'Alta', media: 'Media', baja: 'Baja' };
// Evolución de usuarios reales y competencia (si se han consultado) para el .md
async function contextLines(key) {
  const dir = auditDir(key), lines = [];
  const hist = await readFile(join(dir, 'crux-history.json'), 'utf-8').then(JSON.parse).then(c => c.data).catch(() => null);
  if (hist?.periods?.length) {
    lines.push('## Evolución de usuarios reales del dominio (CrUX)', '', `Percentil 75 por periodos de 28 días, del ${new Date(hist.periods[0]).toLocaleDateString('es-ES')} al ${new Date(hist.periods.at(-1)).toLocaleDateString('es-ES')}:`, '');
    for (const id of ['lcp', 'inp', 'cls']) {
      const v = (hist.series[id] || []).filter(x => x != null);
      if (v.length) lines.push(`- ${fieldNames[id]}: ${fieldFormat[id](v[0])} → ${fieldFormat[id](v.at(-1))} (mínimo ${fieldFormat[id](Math.min(...v))}, máximo ${fieldFormat[id](Math.max(...v))})`);
    }
    lines.push('');
  }
  const bench = await crux.savedBenchmark(dir);
  if (bench?.results?.length) {
    lines.push('## Usuarios reales frente a la competencia (CrUX, 28 días)', '');
    for (const r of bench.results) lines.push(`- ${r.domain}${r.own ? ' (esta web)' : ''}: ` + (r.field ? ['lcp', 'inp', 'cls'].filter(id => r.field.metrics[id]).map(id => `${fieldNames[id]} ${fieldFormat[id](r.field.metrics[id].p75)} (${ratingNames[r.field.metrics[id].rating]})`).join(' · ') : 'sin datos suficientes'));
    lines.push('');
  }
  return lines;
}
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
    ...await contextLines(key),
    '## Problemas repetidos en varias URLs', '',
    ...[...repeated.values()].sort((a, b) => b.urls - a.urls).slice(0, 20).map(e => `- [${catNames[e.category]}] ${e.title} — ${e.urls} URL${e.urls > 1 ? 's' : ''}`), '',
    '## URLs por prioridad', ''
  ];
  for (const r of reports) {
    lines.push(`### ${r.url}`, '', `Prioridad: **${levelNames[r.level]}** (gravedad ${r.severity}) · ` + Object.entries(scoreNames).map(([id, n]) => `${n} ${r.scores[id] ?? '–'}`).join(' · '), ...fieldLine(r.field, !!originField), ...googleLine(r.google), '');
    lines.push(...issueLines(r.issues.slice(0, 10), 2), '');
  }
  return lines.join('\n');
}
// Petición para Claude al principio del .md: basta con soltar el archivo en una conversación
function claudeBrief(tasks) {
  return [
    '## Instrucciones para Claude', '',
    'Actúa como consultor/a senior de SEO técnico y rendimiento web. Este archivo contiene datos de Google Lighthouse exportados por la herramienta «Technical SEO Report». Analízalos y responde en español:', '',
    ...tasks.map((t, n) => `${n + 1}. ${t}`), '',
    'Básate solo en los datos de este archivo; si algo requiere comprobarse en la web, dilo. «Qué hacer» y «Dónde» son pistas de la herramienta: concrétalas para este caso.',
    'Las puntuaciones de Lighthouse son de laboratorio (una carga simulada). Cuando haya datos de «Usuarios reales» (CrUX), dales prioridad: son las Core Web Vitals que Google usa como señal, y contrástalos con el laboratorio para explicar diferencias. Los datos de «Google (Search Console)» son el estado real de indexación y rastreo según Google: son los más fiables y tienen prioridad sobre las comprobaciones de «Renderizado para Google», que son una simulación.', '',
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
  const scope = f.scope === 'origin' ? ', datos de todo el dominio: esta URL no tiene tráfico suficiente'
    : f.scope === 'url-all' ? ', móvil y escritorio juntos: por separado no hay tráfico suficiente' : '';
  return [`- Usuarios reales (CrUX, percentil 75, 28 días${scope}): ${values}`];
}
function googleLine(q) {
  if (!q || q.status === 'noAccess' || q.status === 'error') return [];
  return [`- Google (Search Console, datos reales): ${googleNames[q.status]}${q.coverage ? ' — ' + q.coverage : ''}${q.lastCrawl ? ' · último rastreo ' + new Date(q.lastCrawl).toLocaleDateString('es-ES') + (q.crawledAs ? ' (' + (q.crawledAs === 'MOBILE' ? 'Googlebot móvil' : 'Googlebot escritorio') + ')' : '') : ' · sin rastrear'}`];
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
    `- Puntuaciones: ` + Object.entries(scoreNames).map(([id, n]) => `${n} ${r.scores[id] ?? '–'}`).join(' · '),
    ...fieldLine(r.field), ...googleLine(r.google), '',
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
  const rows = [['URL', 'Prioridad', 'Gravedad', ...Object.values(scoreNames), ...vitals.map(id => `${fieldNames[id]} real (p75)`), 'Datos reales de', 'Renderizado para Google', 'Google (Search Console)', 'Cobertura en Google', 'Último rastreo de Google', 'Problemas', 'Principales problemas']];
  for (const r of await resultReports(key)) rows.push([r.url, levelNames[r.level], r.severity, ...Object.keys(scoreNames).map(id => r.scores[id]),
    ...vitals.map(id => r.field?.metrics[id] ? `${fieldFormat[id](r.field.metrics[id].p75)} (${ratingNames[r.field.metrics[id].rating]})` : ''),
    r.field ? ({ url: 'URL', 'url-all': 'URL (móvil + escritorio)', origin: 'Dominio' }[r.field.scope]) : r.field === null ? 'Sin datos' : '',
    r.render ? renderNames[r.render.status] : '',
    r.google ? googleNames[r.google.status] : '', r.google?.coverage || '', r.google?.lastCrawl ? new Date(r.google.lastCrawl).toLocaleDateString('es-ES') : '',
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
    const query = new URL(req.url, 'http://x').searchParams;
    if (req.method === 'GET' && path === '/' && query.has('state') && (query.has('code') || query.has('error'))) {
      let msg = 'Search Console conectado. Ya puedes cerrar esta pestaña y volver a la herramienta.';
      try { if (query.has('error')) throw Error('Has cancelado la autorización en Google.'); await gsc.finishAuth(query.get('state'), query.get('code')); } catch (e) { msg = 'No se pudo conectar: ' + e.message; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Search Console</title><body style="font-family:sans-serif;padding:3rem;max-width:40rem"><p>${msg.replace(/</g, '&lt;')}</p><p><a href="/">Volver a la herramienta</a></p><script>window.opener && window.opener.postMessage('gsc-connected', '*')</script></body>`);
    }
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
    if (req.method === 'DELETE' && path === '/api/results') return send(200, { deleted: await deleteAllAudits() });
    if (req.method === 'GET' && path === '/api/compare') return send(200, await compareAudits(query.get('before'), query.get('after')));
    if (req.method === 'GET' && path === '/api/export/compare.md') {
      const name = `antes-despues-${query.get('after').split('/')[0].replace(/[^\w.-]+/g, '-')}.md`;
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
      return res.end(await exportCompareMarkdown(query.get('before'), query.get('after')));
    }
    if (path.startsWith('/api/crux-history/')) {
      const key = path.slice('/api/crux-history/'.length), first = (await resultReports(key))[0];
      return send(200, first ? await crux.history(auditDir(key), new URL(first.url).origin, first.formFactor) : null);
    }
    if (path.startsWith('/api/benchmark/')) {
      const key = path.slice('/api/benchmark/'.length), dir = auditDir(key);
      if (req.method === 'GET') return send(200, await crux.savedBenchmark(dir));
      const first = (await resultReports(key))[0];
      const domains = String((await readJson(req)).domains || '').split(/[\s,;]+/).filter(Boolean).slice(0, 6);
      if (!domains.length) throw Error('Escribe al menos un dominio de la competencia.');
      return send(200, await crux.benchmark(dir, new URL(first.url).host, domains, first.formFactor));
    }
    if (req.method === 'DELETE' && path.startsWith('/api/results/')) { await deleteAudit(path.slice('/api/results/'.length)); return send(200, { ok: true }); }
    if (req.method === 'POST' && path.startsWith('/api/render/')) { await collectRender(path.slice('/api/render/'.length), query.get('force') === '1'); return send(200, { ok: true }); }
    if (req.method === 'POST' && path.startsWith('/api/field/')) { await collectField(path.slice('/api/field/'.length)); return send(200, { ok: true }); }
    if (req.method === 'GET' && path === '/api/settings') return send(200, { crux: await crux.status(), gsc: await gscStatus() });
    if (req.method === 'POST' && path === '/api/settings') { await crux.saveKey((await readJson(req)).cruxApiKey); return send(200, { crux: await crux.status(), gsc: await gscStatus() }); }
    if (req.method === 'POST' && path === '/api/gsc/connect') {
      // cliente propio pegado en Ajustes o, si no, el de la herramienta (google-client.json o variables de entorno)
      const b = await readJson(req), own = b.clientId?.trim() && { clientId: b.clientId.trim(), clientSecret: b.clientSecret?.trim() };
      const client = own || await googleClient(root);
      if (!client) throw Error('Falta el archivo google-client.json con el cliente OAuth de la herramienta. Pídeselo a quien la administra o usa la opción avanzada con tu propio cliente.');
      return send(200, { url: await gsc.authUrl(client.clientId, client.clientSecret, `http://127.0.0.1:${port}/`) });
    }
    if (req.method === 'POST' && path === '/api/gsc/service') { const n = await gsc.saveServiceAccount((await readJson(req)).json); return send(200, { properties: n, gsc: await gscStatus() }); }
    if (req.method === 'POST' && path === '/api/gsc/disconnect') { await gsc.disconnect(); return send(200, { gsc: await gscStatus() }); }
    if (req.method === 'POST' && path.startsWith('/api/google/')) { await collectGoogle(path.slice('/api/google/'.length)); return send(200, { ok: true }); }
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
server.listen(port, '127.0.0.1', () => console.log(`Technical SEO Report: http://127.0.0.1:${port}`));
