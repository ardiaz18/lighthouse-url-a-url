# Site Speed Report

*Lighthouse + usuarios reales, URL a URL*

Herramienta local para auditar un sitio completo con **Google Lighthouse**, página a página, usando el motor [Unlighthouse](https://github.com/harlan-zw/unlighthouse) sin modificar sus resultados.

- Rastrea el sitio (sitemap, robots.txt y enlaces internos) y ejecuta Lighthouse en cada URL, en móvil o escritorio.
- Muestra el **informe Lighthouse completo de cada URL**, en español.
- Ordena las URLs por **gravedad** (Alta / Media / Baja), dando más peso a Rendimiento y SEO.
- Muestra los **datos de usuarios reales** (Core Web Vitals de CrUX, los mismos de PageSpeed Insights) junto a los de laboratorio, con una clave gratuita de Google.
- Opcional: **Renderizado para Google**, que avisa de recursos bloqueados por robots.txt y de contenido que solo aparece con JavaScript.
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

## Datos de usuarios reales (CrUX)

La columna **Usuarios reales** muestra LCP, INP y CLS de visitantes reales de Chrome (percentil 75, últimos 28 días): son los datos de «Descubre lo que experimentan tus usuarios reales» de PageSpeed Insights. Si una URL no tiene tráfico suficiente se muestran los del dominio, marcados como tales.

Necesita una clave gratuita de Google Cloud (sin tarjeta). Cada persona usa la suya:

1. Entra en https://console.cloud.google.com y crea un proyecto.
2. En **APIs y servicios → Biblioteca**, busca **Chrome UX Report API** y pulsa **Habilitar**.
3. En **APIs y servicios → Credenciales**, pulsa **Crear credenciales → Clave de API**.
4. Edita la clave y, en **Restricciones de API**, limítala a **Chrome UX Report API**.
5. En la herramienta, pulsa el icono de **Ajustes** (⚙), pega la clave y guarda.

La clave se guarda solo en tu equipo (`settings.json`, que no se sube a git). En un servidor, usa la variable de entorno `CRUX_API_KEY`. Los datos se consultan una vez por auditoría y se guardan con ella. El límite gratuito es de 150 consultas por minuto.

## Renderizado para Google (opcional)

Marca **Comprobar renderizado para Google** al lanzar una auditoría, o pulsa el botón del mismo nombre en una ya hecha. Al terminar la auditoría (para no falsear las mediciones de rendimiento), comprueba en cada URL:

- **Recursos bloqueados por robots.txt:** JS, CSS y peticiones de datos que Googlebot no puede descargar según las reglas de Google (grupo de Googlebot o `*`, la regla más larga gana). Sin ellos Google puede ver la página rota.
- **HTML inicial frente a renderizado:** si la meta robots, la canonical, el título, el H1, los enlaces internos o el texto solo aparecen (o cambian) al ejecutar JavaScript.
- **Contenido oculto por CSS:** renderiza como Google (pantalla tan alta como la página, sin scroll ni clics) y mide el texto principal invisible (`opacity`, `visibility`, `display:none`). Después interactúa como una persona (ratón y rueda) para distinguir lo que **solo aparece al interactuar** —Googlebot no interactúa; causa habitual: animaciones de entrada con «Retrasar JavaScript» de WP Rocket, LiteSpeed o Perfmatters— de carruseles, pestañas y efectos. Fiabilidad media: el renderizador de Google no se puede reproducir exacto.

Imita el renderizado de Google, pero no es su vista real: no detecta bloqueos por IP ni sabe qué ha indexado Google (para eso, conecta Search Console). Añade entre 10 y 30 segundos por URL.

## Limitaciones

- Solo escucha en 127.0.0.1. No publicarlo en Internet sin autenticación, control de SSRF y colas.
- Máximo 2 auditorías simultáneas.
- Audita como máximo 200 URLs por sitio y, por defecto, 8 por tipo de página (muestreo de Unlighthouse). El panel avisa cuando se ha muestreado o se ha llegado al límite; «Opciones avanzadas → Auditar todas las URLs, sin muestreo» lo desactiva.
- No funciona en GitHub Pages: necesita un servidor con Node.js y Chrome.
- El idioma del informe solo cambia los textos; las mediciones son las de Lighthouse.

## Créditos

Motor: [Unlighthouse](https://github.com/harlan-zw/unlighthouse) (MIT, © Harlan Wilton y colaboradores) y [Google Lighthouse](https://github.com/GoogleChrome/lighthouse) (Apache-2.0), instalados como dependencias sin modificar.

Autora: [Alicia Ruiz](https://aliciaruiz.es/blog/)
