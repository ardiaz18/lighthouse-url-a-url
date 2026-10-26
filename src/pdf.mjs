// Informe en PDF para el cliente, con la marca de Alicia Ruiz.
// Se genera como HTML y se imprime con el Chrome del equipo (puppeteer-core).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { Launcher } from 'chrome-launcher';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const words = { good: 'Bueno', needs: 'Mejorable', poor: 'Malo' };
const band = v => v == null ? '' : v >= 90 ? 'good' : v >= 50 ? 'needs' : 'poor';
const date = d => new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });

// Minigráfico de tendencia (SVG) para la evolución de usuarios reales
function spark(values, limit) {
  const pts = values.map((v, i) => [i, v]).filter(p => p[1] != null);
  if (pts.length < 2) return '';
  const W = 220, H = 46, pad = 5;
  const lo = Math.min(...pts.map(p => p[1]), 0), hi = Math.max(...pts.map(p => p[1]), limit);
  const x = i => pad + i * (W - 2 * pad) / (values.length - 1), y = v => H - pad - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (H - 2 * pad);
  const [li, lv] = pts.at(-1);
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <line x1="${pad}" x2="${W - pad}" y1="${y(limit)}" y2="${y(limit)}" stroke="#DADADA" stroke-dasharray="3 3"/>
    <polyline fill="none" stroke="#5C5C5C" stroke-width="2" stroke-linejoin="round" points="${pts.map(([i, v]) => x(i) + ',' + y(v)).join(' ')}"/>
    <circle cx="${x(li)}" cy="${y(lv)}" r="4" fill="#0D0D0D"/></svg>`;
}

export async function buildReportHtml(d, root) {
  const logo = await readFile(join(root, 'public', 'assets', 'logo.png')).then(b => 'data:image/png;base64,' + b.toString('base64')).catch(() => '');
  const cats = Object.entries(d.scoreNames);
  const levelCount = l => d.reports.filter(r => r.level === l).length;
  const vitalsFmt = d.fieldFormat;
  const section = (title, body, note = '', cls = '') => `<section class="${cls}"><h2>${title}</h2>${note ? `<p class="lead">${note}</p>` : ''}${body}</section>`;

  // resumen: medias por categoría
  const scoreTiles = cats.map(([id, n]) => {
    const v = d.averages[id];
    return `<div class="tile"><span class="lbl">${n}</span><span class="big ${band(v)}">${v ?? '–'}</span><span class="tag ${band(v)}">${v == null ? '' : v >= 90 ? 'Bien' : v >= 50 ? 'A mejorar' : 'Prioritario'}</span></div>`;
  }).join('');

  // usuarios reales del dominio (dato actual y evolución)
  let real = '';
  if (d.origin || d.history) {
    const cells = ['lcp', 'inp', 'cls'].map(id => {
      const now = d.origin?.metrics[id];
      const series = d.history?.series?.[id] || [], known = series.filter(v => v != null);
      const limit = { lcp: 2500, inp: 200, cls: 0.1 }[id];
      // el dato más reciente: el último punto de la evolución o, si no la hay, el guardado con la auditoría
      const current = known.length ? known.at(-1) : now?.p75;
      if (current == null) return '';
      const rating = current <= limit ? 'good' : current <= { lcp: 4000, inp: 500, cls: 0.25 }[id] ? 'needs' : 'poor';
      return `<div class="tile"><span class="lbl">${d.fieldNames[id]}</span><span class="big">${vitalsFmt[id](current)}</span><span class="tag ${rating}">${words[rating]}</span>
        ${known.length > 1 ? spark(series, limit) + `<span class="small">Hace ${Math.round(series.length / 4.3)} meses: ${vitalsFmt[id](known[0])}</span>` : ''}</div>`;
    }).join('');
    real = section('Experiencia de usuarios reales', `<div class="tiles three">${cells}</div>`,
      'Así cargan las páginas para los visitantes reales que usan Chrome (datos de Google, últimos 28 días). Son las Core Web Vitals que Google tiene en cuenta como señal de experiencia de página. La línea discontinua marca el umbral «bueno».');
  }

  // estado en Google (Search Console) y renderizado
  const gsc = d.reports.filter(r => r.google && !['noAccess', 'error'].includes(r.google.status));
  const gscBlock = gsc.length ? section('Estado en Google', `<div class="tiles three">
      <div class="tile"><span class="lbl">Indexadas</span><span class="big good">${gsc.filter(r => r.google.status === 'indexed').length}</span><span class="small">de ${gsc.length} URLs consultadas</span></div>
      <div class="tile"><span class="lbl">No indexadas</span><span class="big ${gsc.some(r => r.google.status === 'notIndexed') ? 'poor' : ''}">${gsc.filter(r => r.google.status === 'notIndexed').length}</span></div>
      <div class="tile"><span class="lbl">Google no pudo descargarlas</span><span class="big ${gsc.some(r => r.google.status === 'blocked') ? 'poor' : ''}">${gsc.filter(r => r.google.status === 'blocked').length}</span></div></div>`,
    'Datos de Google Search Console: lo que Google ha hecho realmente con cada página.') : '';
  const rendered = d.reports.filter(r => r.render && r.render.status !== 'error');
  const renderBlock = rendered.length ? section('Cómo ve Google las páginas', `<div class="tiles three">
      <div class="tile"><span class="lbl">Correctas</span><span class="big good">${rendered.filter(r => r.render.status === 'ok').length}</span></div>
      <div class="tile"><span class="lbl">A revisar</span><span class="big needs">${rendered.filter(r => r.render.status === 'aviso').length}</span></div>
      <div class="tile"><span class="lbl">Con problemas</span><span class="big poor">${rendered.filter(r => r.render.status === 'problema').length}</span></div></div>`,
    'Comprobación de si Google puede ver el contenido: archivos bloqueados, contenido que depende de JavaScript o que solo aparece al interactuar, e indexabilidad.') : '';

  // competencia
  const bench = d.benchmark?.results?.length ? section('Frente a la competencia', `<table><thead><tr><th>Dominio</th><th>LCP</th><th>INP</th><th>CLS</th></tr></thead><tbody>
    ${d.benchmark.results.map(r => `<tr class="${r.own ? 'own' : ''}"><td>${esc(r.domain)}${r.own ? ' <b>(esta web)</b>' : ''}</td>${['lcp', 'inp', 'cls'].map(id => { const m = r.field?.metrics[id]; return `<td>${m ? `<span class="pill ${m.rating}">${vitalsFmt[id](m.p75)}</span>` : '<span class="muted">Sin datos</span>'}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table>`, 'Experiencia de usuarios reales del dominio completo frente a la competencia (datos de Google, últimos 28 días).') : '';

  // problemas principales del sitio, con qué hacer
  // en la herramienta los recursos afectados se llaman «Dónde»; en el informe, «Ejemplo»
  const forReport = t => String(t).replace(/de «Dónde»/g, 'del ejemplo').replace(/«Dónde»/g, 'el ejemplo').replace(/(^|[.:]\s+)el ejemplo/g, (m, p) => p + 'El ejemplo');
  const top = d.topIssues.slice(0, 8).map((i, n) => `<div class="issue"><div class="issue-head"><span class="num">${n + 1}</span><div><span class="cat">${esc(i.category)}</span><h3>${esc(i.title)}</h3></div><span class="count">${i.urls} URL${i.urls > 1 ? 's' : ''}</span></div>
    ${i.action ? `<p><b>Qué hacer:</b> ${esc(forReport(i.action))}</p>` : ''}${i.where ? `<p class="small"><b>Ejemplo:</b> ${esc(i.where)}</p>` : ''}</div>`).join('');

  // URLs prioritarias
  const urlRow = r => `<tr><td><span class="pill ${r.level === 'alta' ? 'poor' : r.level === 'media' ? 'needs' : 'good'}">${{ alta: 'Alta', media: 'Media', baja: 'Baja' }[r.level]}</span></td>
    <td class="url">${esc(r.url.replace(/^https?:\/\/(www\.)?/, ''))}</td>${cats.map(([id]) => `<td><span class="pill ${band(r.scores[id])}">${r.scores[id] ?? '–'}</span></td>`).join('')}</tr>`;
  const head = `<thead><tr><th>Prioridad</th><th>URL</th>${cats.map(([, n]) => `<th>${n}</th>`).join('')}</tr></thead>`;
  const priority = d.reports.slice(0, 15).map(r => `${urlRow(r)}${r.issues.length ? `<tr class="sub"><td></td><td colspan="${cats.length + 1}">${r.issues.slice(0, 3).map(i => esc(i.title)).join(' · ')}</td></tr>` : ''}`).join('');

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe de SEO técnico — ${esc(d.host)}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Questrial&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap">
<style>
@page{size:A4;margin:18mm 16mm 20mm}
*{box-sizing:border-box}
body{margin:0;font-family:'Questrial',Arial,sans-serif;color:#3D3D3D;font-size:10.5pt;line-height:1.55}
h1,h2,h3{font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#0D0D0D;letter-spacing:-.02em}
h2{font-size:15pt;margin:0 0 .3rem;padding-top:.2rem}
h3{font-size:10.5pt;margin:0}
section{margin:0 0 9mm;break-inside:avoid-page}
.lead{color:#5C5C5C;margin:0 0 .8rem;font-size:9.5pt}
.cover{height:250mm;display:flex;flex-direction:column;justify-content:space-between;break-after:page}
.cover img{height:30px;width:auto}
.eyebrow{font-family:'Plus Jakarta Sans',Arial,sans-serif;font-weight:700;font-size:9pt;letter-spacing:.12em;text-transform:uppercase;color:#E8451F}
.cover h1{font-size:34pt;line-height:1.05;margin:.6rem 0 .8rem;font-weight:800}
.cover .site{font-size:15pt;color:#0D0D0D;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-weight:700}
.cover .meta{color:#5C5C5C;margin-top:.3rem}
.cover .by{border-top:1px solid #E8E8E8;padding-top:6mm;color:#5C5C5C;font-size:9.5pt}
.bar{height:6px;width:60px;background:#FF5C35;border-radius:6px;margin-bottom:6mm}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:4mm}
.tiles.three{grid-template-columns:repeat(3,1fr)}
.tile{border:1px solid #E8E8E8;border-radius:10px;padding:4mm;display:flex;flex-direction:column;gap:1.5mm}
.lbl{font-family:'Plus Jakarta Sans',Arial,sans-serif;font-weight:700;font-size:7.5pt;letter-spacing:.06em;text-transform:uppercase;color:#5C5C5C}
.big{font-family:'Plus Jakarta Sans',Arial,sans-serif;font-weight:800;font-size:22pt;color:#0D0D0D;line-height:1}
.big.good{color:#137333}.big.needs{color:#B06000}.big.poor{color:#C5221F}
.tag,.pill{display:inline-block;width:max-content;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-weight:700;font-size:7.5pt;border-radius:100px;padding:.5mm 2.5mm;background:#EDEDED;color:#0D0D0D}
.good.tag,.pill.good{background:#E6F4EA;color:#137333}.needs.tag,.pill.needs{background:#FEF7E0;color:#B06000}.poor.tag,.pill.poor{background:#FCE8E6;color:#C5221F}
.small{font-size:8.5pt;color:#5C5C5C}
.muted{color:#888}
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm;margin-top:4mm}
.issue{border:1px solid #E8E8E8;border-radius:10px;padding:3.5mm 4mm;margin-bottom:3mm;break-inside:avoid}
.issue-head{display:grid;grid-template-columns:8mm 1fr auto;gap:3mm;align-items:start}
.num{font-family:'Plus Jakarta Sans',Arial,sans-serif;font-weight:800;color:#FF5C35;font-size:13pt;line-height:1}
.cat{font-family:'Plus Jakarta Sans',Arial,sans-serif;font-weight:700;font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#E8451F}
.count{font-size:8.5pt;color:#5C5C5C;white-space:nowrap}
.issue p{margin:1.5mm 0 0 11mm;font-size:9.5pt}
table{width:100%;border-collapse:collapse;font-size:8.5pt}
th{font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:7pt;letter-spacing:.05em;text-transform:uppercase;color:#5C5C5C;text-align:left;padding:2mm 1.5mm;border-bottom:1px solid #E8E8E8}
td{padding:1.8mm 1.5mm;border-bottom:1px solid #F0F0F0;vertical-align:top}
td.url{word-break:break-all;color:#0D0D0D}
tr.sub td{border-bottom:1px solid #E8E8E8;color:#5C5C5C;font-size:7.8pt;padding-top:0}
tr.own td{background:#FFF1EE}
tr{break-inside:avoid}
.cta{background:#0D0D0D;color:#fff;border-radius:12px;padding:7mm 8mm;break-inside:avoid}
.cta h2{color:#fff}
.cta p{color:#E0E0E0;margin:.3rem 0 0}
.cta a{color:#FF8A6B;font-weight:700;text-decoration:none}
.notes{font-size:8pt;color:#888;margin-top:6mm}
/* las tablas largas pueden repartirse entre páginas (la cabecera se repite) */
section.annex,section.long{break-inside:auto}
thead{display:table-header-group}
tr.sub{break-before:avoid}
</style></head><body>
<div class="cover">
  <div>${logo ? `<img src="${logo}" alt="Alicia Ruiz">` : '<b>Alicia Ruiz</b>'}</div>
  <div>
    <div class="bar"></div>
    <div class="eyebrow">Informe de SEO técnico</div>
    <h1>Rendimiento, renderizado e indexación</h1>
    <div class="site">${esc(d.host)}</div>
    <div class="meta">${d.selected ? `${d.reports.length} URLs seleccionadas de ${d.total} analizadas` : `${d.reports.length} URLs analizadas`} · ${d.device} · ${date(d.date)}</div>
  </div>
  <div class="by">Elaborado por <b>Alicia Ruiz</b>, consultora de SEO técnico · aliciaruiz.es</div>
</div>

${section('Resumen', `<div class="tiles">${scoreTiles}</div>
  <div class="summary">
    <div class="tile"><span class="lbl">Prioridad alta</span><span class="big poor">${levelCount('alta')}</span><span class="small">URLs que conviene corregir primero</span></div>
    <div class="tile"><span class="lbl">Prioridad media</span><span class="big needs">${levelCount('media')}</span><span class="small">URLs con mejoras pendientes</span></div>
    <div class="tile"><span class="lbl">Sin problemas importantes</span><span class="big good">${levelCount('baja')}</span><span class="small">URLs en buen estado</span></div>
  </div>`, (d.selected ? `Selección de las ${d.reports.length} páginas más relevantes. ` : '') + 'Puntuación media de las páginas analizadas con Google Lighthouse (de 0 a 100). A partir de 90 es buena; por debajo de 50 requiere atención prioritaria.')}

${real}
${gscBlock}
${renderBlock}
${bench}

${top ? section('Qué conviene corregir', top, 'Problemas más repetidos en el sitio, ordenados por el número de páginas afectadas, con la acción recomendada.', 'long') : ''}

${section('Páginas prioritarias', `<table>${head}<tbody>${priority}</tbody></table>`, 'Las 15 URLs con más margen de mejora, con sus principales problemas.', 'long')}

<section class="cta">
  <h2>¿Te ayudo a corregirlo?</h2>
  <p>Puedo encargarme de aplicar estas mejoras o acompañar a tu equipo para hacerlo, empezando por lo que más impacto tiene en tu visibilidad.</p>
  <p><a href="https://aliciaruiz.es/contacto/">aliciaruiz.es/contacto</a></p>
</section>

${d.reports.length > 15 ? `<section class="annex"><h2>Anexo: ${d.selected ? 'todas las URLs seleccionadas' : 'todas las URLs analizadas'}</h2><table>${head}<tbody>${d.reports.map(urlRow).join('')}</tbody></table></section>` : ''}

<p class="notes">Puntuaciones de laboratorio de Google Lighthouse, que pueden variar unos puntos entre mediciones. Datos de usuarios reales del Chrome UX Report de Google${gsc.length ? ' y estado de indexación de Google Search Console' : ''}. Generado con Technical SEO Report.</p>
</body></html>`;
}

export async function renderPdf(html) {
  const executablePath = Launcher.getFirstInstallation();
  if (!executablePath) throw Error('No se encuentra Google Chrome en este equipo.');
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    return await page.pdf({
      format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;font-size:7pt;color:#888;padding:0 16mm;display:flex;justify-content:space-between;font-family:Arial"><span>Informe de SEO técnico · Alicia Ruiz</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
    });
  } finally {
    await browser.close().catch(() => {});
  }
}
