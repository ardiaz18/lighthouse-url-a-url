// Search Console: lo que Google ha hecho de verdad con cada URL (API de Inspección de URLs).
// Conexión con cuenta de Google (OAuth, cliente de escritorio) o con cuenta de servicio.
// Las credenciales se guardan solo en este equipo (settings.json, fuera de git).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createSign, randomBytes } from 'node:crypto';

const version = 1;
const scope = 'https://www.googleapis.com/auth/webmasters.readonly';
const tokenUrl = 'https://oauth2.googleapis.com/token';

// Textos en español para los estados de la API
export const fetchStates = {
  SOFT_404: 'Soft 404', BLOCKED_ROBOTS_TXT: 'Bloqueada por robots.txt', NOT_FOUND: 'No encontrada (404)',
  ACCESS_DENIED: 'Acceso denegado (401)', SERVER_ERROR: 'Error del servidor (5xx)', REDIRECT_ERROR: 'Error de redirección',
  ACCESS_FORBIDDEN: 'Acceso prohibido (403)', BLOCKED_4XX: 'Bloqueada por un error 4xx', INTERNAL_CRAWL_ERROR: 'Error interno de rastreo', INVALID_URL: 'URL no válida'
};
export const indexingStates = { BLOCKED_BY_META_TAG: 'noindex en la meta robots', BLOCKED_BY_HTTP_HEADER: 'noindex en la cabecera X-Robots-Tag', BLOCKED_BY_ROBOTS_TXT: 'bloqueada por robots.txt' };

const b64url = data => Buffer.from(data).toString('base64url');

export function createGsc(root) {
  const settingsFile = join(root, 'settings.json');
  const readSettings = () => readFile(settingsFile, 'utf-8').then(JSON.parse).catch(() => ({}));
  const saveGsc = async gsc => {
    const settings = await readSettings();
    if (gsc) settings.gsc = gsc; else delete settings.gsc;
    await writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
    token = null;
    sites = null;
  };
  let token = null, sites = null;
  const pendingAuth = new Map();

  async function postToken(body) {
    const res = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.assertion) throw Error(`Google no acepta la cuenta de servicio (${data.error_description || data.error || res.status}). Comprueba que has pegado el archivo .json correcto y que la cuenta y su clave siguen existiendo en Google Cloud.`);
      if (data.error === 'invalid_grant') throw Error('Google ha caducado o revocado la conexión. Vuelve a conectar Search Console en Ajustes (si la app de Google Cloud está «En pruebas», caduca cada 7 días: pásala a «En producción»).');
      throw Error(`Google rechazó la autorización: ${data.error_description || data.error || res.status}`);
    }
    return data;
  }
  async function accessToken() {
    if (token && token.expires > Date.now() + 60000) return token.value;
    const { gsc } = await readSettings();
    if (!gsc) throw Error('Conecta Search Console en Ajustes.');
    let data;
    if (gsc.serviceAccount) {
      // cuenta de servicio: JWT firmado con su clave privada
      const sa = gsc.serviceAccount, now = Math.floor(Date.now() / 1000);
      const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri || tokenUrl, iat: now, exp: now + 3600 }));
      const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
      data = await postToken({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + signature });
    } else {
      data = await postToken({ grant_type: 'refresh_token', refresh_token: gsc.refreshToken, client_id: gsc.clientId, client_secret: gsc.clientSecret });
    }
    token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
    return token.value;
  }
  async function api(url, body) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || '';
      if (res.status === 429 || /quota/i.test(msg)) throw Object.assign(Error('Se ha alcanzado el límite de Google (2.000 inspecciones al día por propiedad). Las URLs pendientes se consultarán mañana.'), { quota: true });
      if (res.status === 403 && /has not been used|disabled/i.test(msg)) throw Error('Habilita «Google Search Console API» en tu proyecto de Google Cloud.');
      throw Object.assign(Error(`Search Console respondió ${res.status}: ${msg}`), { status: res.status });
    }
    return data;
  }
  async function properties() {
    sites ??= (await api('https://www.googleapis.com/webmasters/v3/sites')).siteEntry?.filter(s => s.permissionLevel !== 'siteUnverifiedUser') || [];
    return sites;
  }
  // propiedad que cubre la URL: prefijo de URL más largo o, si no, propiedad de dominio
  async function propertyFor(url) {
    const u = new URL(url), list = await properties();
    const prefix = list.filter(s => !s.siteUrl.startsWith('sc-domain:') && url.startsWith(s.siteUrl)).sort((a, b) => b.siteUrl.length - a.siteUrl.length)[0];
    if (prefix) return prefix.siteUrl;
    return list.find(s => s.siteUrl.startsWith('sc-domain:') && (u.hostname === s.siteUrl.slice(10) || u.hostname.endsWith('.' + s.siteUrl.slice(10))))?.siteUrl || null;
  }

  return {
    async status() {
      const { gsc } = await readSettings();
      if (!gsc) return { connected: false };
      return { connected: true, mode: gsc.serviceAccount ? 'service' : 'oauth', account: gsc.serviceAccount?.client_email || gsc.email || '', hasClient: !!gsc.clientId };
    },
    async saveServiceAccount(json) {
      let sa;
      try { sa = JSON.parse(json); } catch { throw Error('Pega el contenido completo del archivo .json de la cuenta de servicio.'); }
      if (sa.type !== 'service_account' || !sa.private_key || !sa.client_email) throw Error('Ese archivo no es una clave de cuenta de servicio de Google Cloud.');
      await saveGsc({ serviceAccount: sa });
      const list = await properties().catch(async e => { await saveGsc(null); throw e; });
      return list.length;
    },
    // OAuth para aplicación de escritorio: redirección a 127.0.0.1 y PKCE
    async authUrl(clientId, clientSecret, redirectUri) {
      if (!clientId || !clientSecret) throw Error('Pega el ID de cliente y el secreto del cliente OAuth.');
      const state = b64url(randomBytes(16)), verifier = b64url(randomBytes(32));
      pendingAuth.set(state, { clientId, clientSecret, verifier, redirectUri });
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scope + ' email', access_type: 'offline', prompt: 'consent', state, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
    },
    async finishAuth(state, code) {
      const p = pendingAuth.get(state);
      if (!p) throw Error('La autorización ha caducado. Vuelve a pulsar «Conectar con Google».');
      pendingAuth.delete(state);
      const data = await postToken({ grant_type: 'authorization_code', code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, code_verifier: p.verifier });
      if (!data.refresh_token) throw Error('Google no devolvió un permiso permanente. Quita el acceso de la app en tu cuenta de Google y vuelve a conectar.');
      const email = data.id_token ? JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString()).email : '';
      await saveGsc({ clientId: p.clientId, clientSecret: p.clientSecret, refreshToken: data.refresh_token, email });
    },
    disconnect: () => saveGsc(null),
    async cached(dir) {
      const cache = await readFile(join(dir, 'gsc.json'), 'utf-8').then(JSON.parse).catch(() => null);
      return cache?.version === version ? cache.data : null;
    },
    // inspecciona las URLs que falten (600 por minuto como máximo) y guarda el resultado con la auditoría
    async collect(dir, urls) {
      const data = (await this.cached(dir)) || {};
      const save = () => writeFile(join(dir, 'gsc.json'), JSON.stringify({ version, fetchedAt: new Date().toISOString(), data }), 'utf-8');
      for (const url of urls.filter(u => !(u in data))) {
        const siteUrl = await propertyFor(url);
        if (!siteUrl) { data[url] = { noAccess: true }; await save(); continue; }
        try {
          const r = (await api('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { inspectionUrl: url, siteUrl, languageCode: 'es' })).inspectionResult?.indexStatusResult || {};
          data[url] = { siteUrl, verdict: r.verdict, coverage: r.coverageState, robots: r.robotsTxtState, indexing: r.indexingState, fetch: r.pageFetchState, lastCrawl: r.lastCrawlTime, crawledAs: r.crawledAs, googleCanonical: r.googleCanonical, userCanonical: r.userCanonical, sitemaps: r.sitemap || [] };
        } catch (e) {
          if (e.quota) { await save(); throw e; }
          data[url] = { error: e.message };
        }
        await save();
        await new Promise(r => setTimeout(r, 110));
      }
      return data;
    }
  };
}
