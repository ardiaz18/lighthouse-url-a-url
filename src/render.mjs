// Renderizado para Google: comprobaciones de hechos, no una simulación de Googlebot.
// 1) recursos críticos (JS, CSS, datos) bloqueados para Googlebot por robots.txt
// 2) HTML inicial (sin JavaScript) frente a la página renderizada
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { Launcher } from 'chrome-launcher';

// 5: renderizado más parecido al de Google (contexto limpio, espera a que se estabilice, animaciones
// adelantadas, HTML inicial del propio Chrome) e indexabilidad. Los resultados de la 4 se siguen mostrando.
const version = 5;
// Chrome móvil con la versión real del Chrome instalado (se ajusta al arrancar)
let mobileUA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
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
// Qué recursos bloqueados importan para el renderizado: solo los del propio sitio (JS, CSS y datos).
// Los de otros dominios dependen de su robots.txt, que no se puede cambiar, y se ignoran.
const site = host => {
  const parts = host.replace(/^www\./, '').split('.');
  return parts.slice(parts.length > 2 && parts.at(-2).length <= 3 && parts.at(-1).length === 2 ? -3 : -2).join('.');
};
export function blockedRelevance(pageUrl, resourceUrl, type) {
  const page = new URL(pageUrl), res = new URL(resourceUrl);
  return site(res.hostname) === site(page.hostname) ? 'own' : null;
}
function blockedFindings(pageUrl, blocked) {
  const own = blocked.filter(line => blockedRelevance(pageUrl, 'https://' + line.split(' ')[0], (line.match(/\((\w+)\)/) || [])[1]));
  return own.length ? [{ level: 'problema', title: 'Recursos del propio sitio bloqueados por robots.txt', value: `${own.length} recurso${own.length > 1 ? 's' : ''}`, where: own }] : [];
}
// Auditorías anteriores guardaban todos los recursos bloqueados juntos: se reclasifican al leerlas
const oldBlockedTitle = 'Recursos necesarios para renderizar bloqueados por robots.txt';
function reclassify(pageUrl, entry) {
  if (!entry.findings?.some(f => f.title === oldBlockedTitle)) return entry;
  const old = entry.findings.find(f => f.title === oldBlockedTitle);
  const findings = [...entry.findings.filter(f => f !== old), ...blockedFindings(pageUrl, old.where || [])];
  return { ...entry, findings, status: findings.some(f => f.level === 'problema') ? 'problema' : findings.length ? 'aviso' : 'ok' };
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

export // --- texto del contenido principal que sigue invisible sin scroll ni clics (como renderiza Google)
function hiddenContent() {
  const root = document.querySelector('main, [role="main"]') || document.querySelector('article') || document.body;
  // lo que se oculta a propósito y no es contenido principal
  const skip = 'header, footer, nav, aside, [role="dialog"], [aria-modal="true"], [role="menu"], .menu, .sub-menu, .dropdown-menu, [class*="cookie" i], [id*="cookie" i], [class*="modal" i], [class*="popup" i], [class*="offcanvas" i], script, style, noscript, template, svg, select, option, button, form';
  // Elementor, WPBakery (wpb_animate_when_almost_visible), Divi, AOS, WOW, Animate.css, GSAP…
  const anim = /elementor-invisible|animat|aos-|data-aos|\bwow\b|reveal|sal-animate|data-sal|gsap|scroll-?trigger|fade-?(in|up|down|left|right)|appear|et_pb_animation/i;
  const describe = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 3).map(c => '.' + c).join('');
  const groups = new Map();
  let total = 0, hidden = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    const words = node.textContent.split(/\s+/).filter(w => /\p{L}/u.test(w)).length;
    const parent = node.parentElement;
    if (!words || !parent || parent.closest(skip)) continue;
    total += words;
    if (parent.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && parent.getClientRects().length) continue;
    hidden += words;
    // qué antecesor lo oculta y con qué regla
    let culprit = null, reason = '';
    for (let el = parent; el && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      reason = cs.display === 'none' ? 'display:none' : cs.visibility === 'hidden' ? 'visibility:hidden' : parseFloat(cs.opacity) === 0 ? 'opacity:0' : '';
      if (reason) { culprit = el; break; }
    }
    // visibility se hereda: sube hasta el bloque que la declara
    while (reason === 'visibility:hidden' && culprit.parentElement && getComputedStyle(culprit.parentElement).visibility === 'hidden') culprit = culprit.parentElement;
    if (!culprit) continue;
    // las clases y atributos de animación suelen estar en el elemento o en sus contenedores cercanos
    let marks = '';
    for (let e = culprit, i = 0; e && i < 4; e = e.parentElement, i++) marks += ' ' + [...e.attributes].map(a => a.name + '=' + a.value).join(' ');
    if (!groups.has(culprit)) culprit.setAttribute('data-ssr-hidden', String(groups.size)); // para la pasada con scroll
    const g = groups.get(culprit) || { id: groups.size, selector: describe(culprit), reason, animation: anim.test(marks), words: 0, text: '' };
    g.words += words;
    if (g.text.length < 80) g.text = (g.text + ' ' + node.textContent.trim()).trim().slice(0, 80);
    groups.set(culprit, g);
  }
  return { total, hidden, groups: [...groups.values()].sort((a, b) => b.words - a.words) };
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
    if (!blockedRelevance(url, r.url, r.resourceType)) continue; // recursos de otros dominios: su robots.txt no depende de ti
    const rule = blockingRule((await robotsFor(new URL(r.url).origin)).rules, r.url);
    if (rule) blocked.push(`${r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 100)} (${r.resourceType}) — Disallow: ${rule.path}`);
  }
  findings.push(...blockedFindings(url, blocked));

  // 2. Renderizado lo más parecido posible al de Google (Web Rendering Service):
  //    cada URL en un contexto nuevo (sin cookies, caché ni almacenamiento de otras URLs), sin service
  //    workers, con los permisos denegados y la pantalla de Googlebot smartphone (412 px, densidad 2,625)
  const context = await browser.createBrowserContext();
  const tab = await context.newPage();
  const view = height => ({ width: 412, height, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });
  try {
    await tab.setBypassServiceWorker(true);
    await tab.setUserAgent(mobileUA);
    await tab.setViewport(view(732));
    // Google adelanta el tiempo al renderizar: las animaciones y transiciones CSS terminan para él
    const cdp = await tab.createCDPSession();
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 50 });
    const response = await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    if (!response) throw Error('La página no respondió en 45 segundos');
    // HTML inicial tal como lo entrega el servidor al navegador (antes de ejecutar JavaScript)
    const status = response.status(), headers = response.headers(), finalUrl = tab.url();
    const html = await response.text().catch(() => '');
    await settle(tab, 12000);
    const rendered = await tab.evaluate(extract, host);
    // pantalla tan alta como la página, sin scroll: así se disparan las cargas por visibilidad, como en Google
    const height = await tab.evaluate(() => Math.min(document.documentElement.scrollHeight, 12000));
    await tab.setViewport(view(Math.max(732, height)));
    await settle(tab, 6000);
    const css = await tab.evaluate(hiddenContent);
    // confirmación: lo que aparece con un poco más de tiempo estaba a mitad de animación, no oculto
    await new Promise(r => setTimeout(r, 1500));
    const late = new Set(await tab.evaluate(() => [...document.querySelectorAll('[data-ssr-hidden]')].filter(e => e.checkVisibility({ opacityProperty: true, visibilityProperty: true })).map(e => Number(e.dataset.ssrHidden))));
    css.groups = css.groups.filter(g => !late.has(g.id));
    css.hidden = css.groups.reduce((t, g) => t + g.words, 0);
    // segunda pasada: interactuar como una persona (ratón y rueda). Muchos plugins (WP Rocket, LiteSpeed,
    // Perfmatters…) retrasan el JavaScript hasta la primera interacción; Googlebot nunca interactúa
    await tab.setViewport(view(732));
    await tab.mouse.move(120, 300);
    await tab.mouse.move(200, 420, { steps: 5 });
    for (let y = 0; y < height + 732; y += 500) { await tab.mouse.wheel({ deltaY: 500 }); await new Promise(r => setTimeout(r, 150)); }
    await settle(tab, 5000);
    const revealed = new Set(await tab.evaluate(() => [...document.querySelectorAll('[data-ssr-hidden]')].filter(e => e.checkVisibility({ opacityProperty: true, visibilityProperty: true })).map(e => Number(e.dataset.ssrHidden))));
    css.groups.forEach(g => { g.onScroll = revealed.has(g.id); });
    // el HTML inicial se analiza igual que el renderizado, sin JavaScript ni recursos
    const raw = await context.newPage();
    await raw.setJavaScriptEnabled(false);
    await raw.setRequestInterception(true);
    raw.on('request', r => r.url() === 'about:blank' ? r.continue() : r.abort());
    const withBase = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => `${m}<base href="${finalUrl}">`) : `<base href="${finalUrl}">${html}`;
    await raw.setContent(withBase, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const initial = await raw.evaluate(extract, host);

    // indexabilidad: lo que Google mira antes incluso de renderizar
    const noindex = s => /noindex|none/.test(s || '');
    // X-Robots-Tag: «noindex» para todos o «googlebot: noindex»; las reglas de otros robots no cuentan
    const xNoindex = String(headers['x-robots-tag'] || '').toLowerCase().split(/,(?![^:]*,)|\n/).some(part => {
      const m = part.match(/^\s*([a-z-]+)\s*:\s*(.*)$/);
      const [bot, rules] = m && !['noindex', 'nofollow', 'none', 'max-snippet', 'unavailable_after'].includes(m[1]) ? [m[1], m[2]] : ['', part];
      return (!bot || bot === 'googlebot') && /\b(noindex|none)\b/.test(rules);
    });
    if (status >= 400) add('problema', 'La URL responde con un error HTTP', `Código ${status}: Google no indexa páginas que devuelven errores`);
    if (xNoindex) add('problema', 'Bloqueada para indexación por la cabecera X-Robots-Tag', `X-Robots-Tag: ${headers['x-robots-tag']}`);
    if (noindex(rendered.robots) && noindex(initial.robots)) add('problema', 'La página tiene noindex', `meta robots: «${rendered.robots}»`);
    const clean = u => { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, ''); } catch { return u; } };
    if (rendered.canonical && clean(rendered.canonical) !== clean(finalUrl)) add('aviso', 'La canonical apunta a otra URL', `Esta URL indica como principal ${rendered.canonical}: Google indexará normalmente esa otra`);
    if (noindex(initial.robots) !== noindex(rendered.robots)) add('problema', 'La meta robots cambia con JavaScript', `HTML inicial: «${initial.robots || 'sin meta robots'}» · renderizado: «${rendered.robots || 'sin meta robots'}»`);
    if (initial.canonical !== rendered.canonical) {
      if (!initial.canonical) add('aviso', 'La canonical solo aparece con JavaScript', rendered.canonical);
      else add('problema', 'La canonical cambia con JavaScript', `HTML inicial: ${initial.canonical} · renderizado: ${rendered.canonical || 'sin canonical'}`);
    }
    if (!initial.title && rendered.title) add('aviso', 'El título solo aparece con JavaScript', rendered.title);
    if (!initial.h1.length && rendered.h1.length) add('aviso', 'El H1 solo aparece con JavaScript', rendered.h1[0]);
    if (rendered.links >= 5 && initial.links < rendered.links * 0.5) add('aviso', 'Enlaces internos que solo aparecen con JavaScript', `${rendered.links - initial.links} de ${rendered.links} enlaces`);
    if (rendered.words >= 150 && initial.words < rendered.words * 0.5) add('aviso', 'Texto que solo aparece con JavaScript', `${Math.round(100 - 100 * initial.words / rendered.words)} % del texto (${initial.words} de ${rendered.words} palabras en el HTML inicial)`);
    // contenido oculto por CSS (fiabilidad media: el renderizador de Google no se puede reproducir exacto)
    const share = n => css.total ? Math.round(100 * n / css.total) : 0;
    const list = gs => gs.slice(0, 6).map(g => `${g.selector} (${g.reason}${g.animation ? ', animación' : ''}) — ${g.words} palabras: «${g.text}…»`);
    const onScroll = css.groups.filter(g => g.reason !== 'display:none' && g.onScroll);
    const invisible = css.groups.filter(g => g.reason !== 'display:none' && !g.onScroll);
    const collapsed = css.groups.filter(g => g.reason === 'display:none');
    const sum = gs => gs.reduce((t, g) => t + g.words, 0);
    // umbrales: ignorar restos pequeños (p. ej. un 3 % del texto)
    if (sum(onScroll) >= 20 && share(sum(onScroll)) >= 5) add(share(sum(onScroll)) >= 30 ? 'problema' : 'aviso', 'Contenido que solo aparece al interactuar', `${share(sum(onScroll))} % del texto principal (${sum(onScroll)} palabras) solo se ve tras hacer scroll o mover el ratón, y Googlebot no interactúa${onScroll.some(g => g.animation) ? ' (animaciones de entrada)' : ''}`, list(onScroll));
    if (sum(invisible) >= 50 && share(sum(invisible)) >= 10) add('aviso', 'Contenido invisible por CSS aunque se interactúe', `${share(sum(invisible))} % del texto principal (${sum(invisible)} palabras): carrusel, rotativo, pestaña o efecto`, list(invisible));
    if (sum(collapsed) >= 100 && share(sum(collapsed)) >= 40) add('aviso', 'Mucho contenido principal oculto (display:none)', `${share(sum(collapsed))} % del texto principal (${sum(collapsed)} palabras) en pestañas, acordeones o bloques ocultos`, list(collapsed));
    return { status: findings.some(f => f.level === 'problema') ? 'problema' : findings.length ? 'aviso' : 'ok', findings, initial, rendered, css: { total: css.total, hidden: css.hidden } };
  } finally {
    await context.close().catch(() => {});
  }
}
// Espera a que la página «termine», como hace Google antes de tomar el resultado:
// red casi inactiva y DOM sin cambios durante un momento, con un tiempo máximo
async function settle(tab, max) {
  const until = Date.now() + max;
  await tab.waitForNetworkIdle({ idleTime: 700, concurrency: 2, timeout: Math.max(1000, until - Date.now()) }).catch(() => {});
  await tab.evaluate(ms => new Promise(resolve => {
    let timer = setTimeout(done, 800);
    const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 800); });
    const stop = setTimeout(done, ms);
    function done() { obs.disconnect(); clearTimeout(timer); clearTimeout(stop); resolve(); }
    obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }), Math.max(500, until - Date.now())).catch(() => {});
}

export function createRender() {
  return {
    async cached(dir) {
      const cache = await readFile(join(dir, 'render.json'), 'utf-8').then(JSON.parse).catch(() => null);
      if (cache?.version !== version && cache?.version !== 4) return null;
      return Object.fromEntries(Object.entries(cache.data).map(([url, entry]) => [url, entry.status === 'error' ? entry : reclassify(url, entry)]));
    },
    // comprueba las URLs que falten, de dos en dos, y guarda el resultado con la auditoría
    async collect(dir, reports, force) {
      const data = force ? {} : (await this.cached(dir)) || {};
      const pending = reports.filter(r => !(r.url in data));
      if (!pending.length) return data;
      const executablePath = Launcher.getFirstInstallation();
      if (!executablePath) throw Error('No se encuentra Google Chrome en este equipo.');
      const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
      const chrome = (await browser.version()).split('/')[1];
      if (chrome) mobileUA = mobileUA.replace(/Chrome\/[\d.]+/, 'Chrome/' + chrome);
      try {
        const queue = [...pending];
        await Promise.all([0, 1].map(async () => {
          for (let r; (r = queue.shift());) {
            data[r.url] = await checkUrl(browser, r.url, r.requests).catch(e => ({ status: 'error', error: e.message, findings: [] }));
            await writeFile(join(dir, 'render.json'), JSON.stringify({ version: force ? version : (await readFile(join(dir, 'render.json'), 'utf-8').then(JSON.parse).catch(() => ({ version }))).version, data }), 'utf-8');
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
