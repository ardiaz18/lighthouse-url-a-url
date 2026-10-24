# Lighthouse completo URL a URL

Herramienta local para auditar un sitio completo con **Google Lighthouse**, página a página, usando el motor [Unlighthouse](https://github.com/harlan-zw/unlighthouse) sin modificar sus resultados.

- Rastrea el sitio (sitemap, robots.txt y enlaces internos) y ejecuta Lighthouse en cada URL, en móvil o escritorio.
- Muestra el **informe Lighthouse completo de cada URL**, en español.
- Ordena las URLs por **gravedad** (Alta / Media / Baja), dando más peso a Rendimiento y SEO.
- **Analizar con Claude**: descarga un .md con los datos y las instrucciones de análisis ya escritas; basta con soltarlo en una conversación de Claude.
- Detalla cada problema: qué hacer, por qué y dónde (recursos o elementos concretos).
- Analizar con Claude también para cada URL, y exportación en CSV para hojas de cálculo.

## Requisitos

- [Node.js](https://nodejs.org) 22.18 o superior (versión LTS)
- Google Chrome instalado

## Uso

**En Windows:** haz doble clic en `Iniciar.bat`. La primera vez instala lo necesario (unos minutos); después arranca la herramienta y la abre en el navegador. Deja la ventana negra abierta mientras la uses.

En otros sistemas, o desde la terminal:

```bash
npm install
npm run dev
```

Abre http://127.0.0.1:4173, introduce la URL del sitio y pulsa **Iniciar auditoría**.

Los informes se guardan en `.unlighthouse/<dominio>/<id>/reports/**/lighthouse.html` y siguen disponibles tras reiniciar.

CLI original de Unlighthouse, sin panel: `npm run audit -- --site https://ejemplo.com`

## Analizar con Claude

Usa tu suscripción de Claude, sin coste de API:

1. Pulsa **Analizar con Claude** (todo el sitio) o **Claude** en una URL: se descarga un .md con los datos y las instrucciones para Claude.
2. Arrastra el archivo a una conversación en claude.ai y envíalo.

Para hojas de cálculo usa **Descargar CSV**. Con Claude Code, abre la carpeta del proyecto y pide «analiza la última auditoría»: `CLAUDE.md` le indica dónde están los informes.

## Limitaciones

- Solo escucha en 127.0.0.1. No publicarlo en Internet sin autenticación, control de SSRF y colas.
- Máximo 2 auditorías simultáneas.
- No funciona en GitHub Pages: necesita un servidor con Node.js y Chrome.
- El idioma del informe solo cambia los textos; las mediciones son las de Lighthouse.

## Créditos

Motor: [Unlighthouse](https://github.com/harlan-zw/unlighthouse) (MIT, © Harlan Wilton y colaboradores) y [Google Lighthouse](https://github.com/GoogleChrome/lighthouse) (Apache-2.0), instalados como dependencias sin modificar.

Autora: [Alicia Ruiz](https://aliciaruiz.es/blog/)
