# Lighthouse completo URL a URL

Herramienta local para auditar un sitio completo con **Google Lighthouse**, página a página, usando el motor [Unlighthouse](https://github.com/harlan-zw/unlighthouse) sin modificar sus resultados.

- Rastrea el sitio (sitemap, robots.txt y enlaces internos) y ejecuta Lighthouse en cada URL, en móvil o escritorio.
- Muestra el **informe Lighthouse completo de cada URL**, en español.
- Ordena las URLs por **gravedad** (Alta / Media / Baja), dando más peso a Rendimiento y SEO.
- **Analiza con Claude** (API) cada auditoría: diagnóstico, problemas agrupados por causa y plan de acción. El análisis se guarda junto al informe.
- Exporta el resumen priorizado en Markdown y CSV.

## Requisitos

- Node.js 22.18 o superior
- Google Chrome instalado

## Uso

```bash
npm install
npm run dev
```

Abre http://127.0.0.1:4173, introduce la URL del sitio y pulsa **Iniciar auditoría**.

Los informes se guardan en `.unlighthouse/<dominio>/<id>/reports/**/lighthouse.html` y siguen disponibles tras reiniciar.

CLI original de Unlighthouse, sin panel: `npm run audit -- --site https://ejemplo.com`

## Analizar con Claude

1. Crea una clave en https://platform.claude.com/settings/keys (se factura por uso).
2. Copia `.env.example` como `.env` y pega la clave en `ANTHROPIC_API_KEY=`.
3. Reinicia (`npm run dev`) y pulsa **Analizar con Claude** en una auditoría.

También puedes abrir la carpeta con Claude Code y pedir «analiza la última auditoría»: `CLAUDE.md` le indica dónde están los informes.

## Limitaciones

- Solo escucha en 127.0.0.1. No publicarlo en Internet sin autenticación, control de SSRF y colas.
- Máximo 2 auditorías simultáneas.
- No funciona en GitHub Pages: necesita un servidor con Node.js y Chrome.
- El idioma del informe solo cambia los textos; las mediciones son las de Lighthouse.

## Créditos

Motor: [Unlighthouse](https://github.com/harlan-zw/unlighthouse) (MIT, © Harlan Wilton y colaboradores) y [Google Lighthouse](https://github.com/GoogleChrome/lighthouse) (Apache-2.0), instalados como dependencias sin modificar.

Autora: [Alicia Ruiz](https://aliciaruiz.es/blog/)
