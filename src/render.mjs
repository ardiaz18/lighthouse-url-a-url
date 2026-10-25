// Renderizado para Google: comprobaciones de hechos, no una simulación de Googlebot.
// 1) recursos críticos (JS, CSS, datos) bloqueados para Googlebot por robots.txt
// 2) HTML inicial (sin JavaScript) frente a la página renderizada
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { Launcher } from 'chrome-launcher';

const version = 1;
const mobileUA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const critical = new Set(['Script', 'Stylesheet', 'XHR', 'Fetch']);

// --- robots.txt según las reglas de Google (RFC 9309): grupo de Googlebot o *, la regla más larga gana, Allow gana empates
export function parseRobots(text) {
  const groups = [];
  let current = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, field, value] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (field === 'user-agent') {
      if (!lastWasAgent) groups.push(current = { agents: [], rules: [] });
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (field === 'allow' || field === 'disallow') && value) current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const forGoogle = groups.filter(g => g.agents.some(a => a === 'googlebot'));
  const chosen = forGoogle.length ? forGoogle : groups.filter(g => g.agents.includes('*'));
  return chosen.flatMap(g => g.rules);
}
function ruleMatches(path, rule) {
  const pattern = rule.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$');
  return new RegExp('^' + pattern).test(path);
}
export function blockingRule(rules, url) {
  const u = new URL(url);
  const path = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(path, r)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best && !best.allow ? best : null;
}
const robotsCache = new Map();
function robotsFor(origin) {
  if (!robotsCache.has(origin)) robotsCache.set(origin, (async () => {
    try {
      const res = await fetch(origin + '/robots.txt', { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': mobileUA } });
      if (res.status >= 500) return { error: `robots.txt responde ${res.status}`, rules: [] };
      return { rules: res.ok ? parseRobots(await res.text()) : [] }; // 4xx = sin restricciones
    } catch { return { error: 'robots.txt no responde', rules: [] }; }
  })());
  return robotsCache.get(origin);
}

// --- lo que importa para SEO, extraído igual en el HTML inicial y en el renderizado
function extract(host) {
  const meta = name => [...document.querySelectorAll(`meta[name="${name}" i]`)].map(m => m.content.toLowerCase()).join(', ');
  const body = document.body?.cloneNode(true);
  body?.querySelectorAll('script, style, noscript, template, svg').forEach(n => n.remove());
  const links = new Set([...document.querySelectorAll('a[href]')].map(a => { try { const u = new URL(a.getAttribute('href'), document.baseURI); return u.host === host ? u.origin + u.pathname : null; } catch { return null; } }).filter(Boolean));
  return {
    title: document.title.trim(),
    robots: [meta('robots'), meta('googlebot')].filter(Boolean).join(', '),
    canonical: document.querySelector('link[rel="canonical" i]')?.getAttribute('href') ? new URL(document.querySelector('link[rel="canonical" i]').getAttribute('href'), document.baseURI).href : '',
    h1: [...document.querySelectorAll('h1')].map(h => h.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean),
    links: links.size,
    words: (body?.textContent || '').split(/\s+/).filter(w => /\p{L}/u.test(w)).length
  };
}

export async function checkUrl(browser, url, requests) {
  const findings = [];
  const add = (level, title, value, where = []) => findings.push({ level, title, value, where });
  const host = new URL(url).host;

  // 1. robots.txt: la propia URL y sus recursos críticos (cada dominio tiene su robots.txt)
  const page = await robotsFor(new URL(url).origin);
  if (page.error) add('aviso', 'robots.txt no disponible', page.error);
  const pageRule = blockingRule(page.rules, url);
  if (pageRule) add('problema', 'La URL está bloqueada para Googlebot en robots.txt', `Disallow: ${pageRule.path}`);
  const blocked = [];
  for (const r of requests.filter(r => critical.has(r.resourceType) && /^https?:/.test(r.url))) {
    const rule = blockingRule((await robotsFor(new URL(r.url).origin)).rules, r.url);
    if (rule) blocked.push(`${r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 100)} (${r.resourceType}) — Disallow: ${rule.path}`);
  }
  if (blocked.length) add('problema', 'Recursos necesarios para renderizar bloqueados por robots.txt', `${blocked.length} recurso${blocked.length > 1 ? 's' : ''}`, blocked);

  // 2. HTML inicial frente a renderizado (misma extracción en los dos)
  const res = await fetch(url, { headers: { 'User-Agent': mobileUA }, signal: AbortSignal.timeout(20000) });
  const finalUrl = res.url;
  const html = await res.text();
  const tab = await browser.newPage();
  try {
    await tab.setUserAgent(mobileUA);
    await tab.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await tab.goto(url, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    const rendered = await tab.evaluate(extract, host);
    await tab.setJavaScriptEnabled(false);
    await tab.setRequestInterception(true);
    tab.on('request', r => r.isNavigationRequest() ? r.continue() : r.abort());
    const withBase = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => `${m}<base href="${finalUrl}">`) : `<base href="${finalUrl}">${html}`;
    await tab.goto('about:blank');
    await tab.setContent(withBase, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const initial = await tab.evaluate(extract, host);

    const noindex = s => /noindex/.test(s);
    if (noindex(initial.robots) !== noindex(rendered.robots)) add('problema', 'La meta robots cambia con JavaScript', `HTML inicial: «${initial.robots || 'sin meta robots'}» · renderizado: «${rendered.robots || 'sin meta robots'}»`);
    if (initial.canonical !== rendered.canonical) {
      if (!initial.canonical) add('aviso', 'La canonical solo aparece con JavaScript', rendered.canonical);
      else add('problema', 'La canonical cambia con JavaScript', `HTML inicial: ${initial.canonical} · renderizado: ${rendered.canonical || 'sin canonical'}`);
    }
    if (!initial.title && rendered.title) add('aviso', 'El título solo aparece con JavaScript', rendered.title);
    if (!initial.h1.length && rendered.h1.length) add('aviso', 'El H1 solo aparece con JavaScript', rendered.h1[0]);
    if (rendered.links >= 5 && initial.links < rendered.links * 0.5) add('aviso', 'Enlaces internos que solo aparecen con JavaScript', `${rendered.links - initial.links} de ${rendered.links} enlaces`);
    if (rendered.words >= 150 && initial.words < rendered.words * 0.5) add('aviso', 'Texto que solo aparece con JavaScript', `${Math.round(100 - 100 * initial.words / rendered.words)} % del texto (${initial.words} de ${rendered.words} palabras en el HTML inicial)`);
    return { status: findings.some(f => f.level === 'problema') ? 'problema' : findings.length ? 'aviso' : 'ok', findings, initial, rendered };
  } finally {
    await tab.close().catch(() => {});
  }
}

export function createRender() {
  return {
    async cached(dir) {
      const cache = await readFile(join(dir, 'render.json'), 'utf-8').then(JSON.parse).catch(() => null);
      return cache?.version === version ? cache.data : null;
    },
    // comprueba las URLs que falten, de dos en dos, y guarda el resultado con la auditoría
    async collect(dir, reports) {
      const data = (await this.cached(dir)) || {};
      const pending = reports.filter(r => !(r.url in data));
      if (!pending.length) return data;
      const executablePath = Launcher.getFirstInstallation();
      if (!executablePath) throw Error('No se encuentra Google Chrome en este equipo.');
      const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
      try {
        const queue = [...pending];
        await Promise.all([0, 1].map(async () => {
          for (let r; (r = queue.shift());) {
            data[r.url] = await checkUrl(browser, r.url, r.requests).catch(e => ({ status: 'error', error: e.message, findings: [] }));
            await writeFile(join(dir, 'render.json'), JSON.stringify({ version, data }), 'utf-8');
          }
        }));
      } finally {
        await browser.close().catch(() => {});
        robotsCache.clear();
      }
      return data;
    }
  };
}
