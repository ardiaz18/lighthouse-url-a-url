# Technical SEO Report

*Rendimiento, renderizado e indexación, URL a URL*

Herramienta local de auditoría de SEO técnico, URL a URL: **rendimiento** (Google Lighthouse con el motor [Unlighthouse](https://github.com/harlan-zw/unlighthouse), sin modificar sus resultados, y Core Web Vitals de usuarios reales), **renderizado para Google** e **indexación real** con Search Console.

- Rastrea el sitio (sitemap, robots.txt y enlaces internos) y ejecuta Lighthouse en cada URL, en móvil o escritorio.
- Muestra el **informe Lighthouse completo de cada URL**, en español.
- Ordena las URLs por **gravedad** (Alta / Media / Baja), dando más peso a Rendimiento y SEO.
- Muestra los **datos de usuarios reales** (Core Web Vitals de CrUX, los mismos de PageSpeed Insights) junto a los de laboratorio, con una clave gratuita de Google.
- **Evolución de usuarios reales** del dominio en los últimos 6 meses (LCP, INP y CLS, semana a semana).
- **Competencia:** Core Web Vitals reales de tu dominio frente a los de hasta 6 competidores.
- **Informe PDF para el cliente** con tu marca: resumen, usuarios reales y su evolución, estado en Google, renderizado, competencia, qué corregir, páginas prioritarias y llamada a contratar.
- **Selección de URLs:** marca URLs sueltas o tipos completos (portada, páginas, /blog/…) para que «Analizar con Claude», el informe PDF y el CSV incluyan solo las más relevantes.
- **Antes y después:** compara dos auditorías del mismo sitio (medias, URLs que mejoran o empeoran, problemas resueltos y nuevos) y genera un resumen para el cliente con Claude.
- Opcional: **Google Search Console** (datos reales de Google): si cada URL está indexada, si Googlebot pudo descargarla (bloqueos de firewall o CDN), la canonical que eligió y su último rastreo.
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

## Google Search Console

Con Search Console conectado aparece la columna **Google**: el estado real de cada URL según Google (API de Inspección de URLs). Detecta lo que no se puede simular: si la URL está indexada y por qué no, si **Googlebot no pudo descargarla** en su último rastreo (403 por firewall o CDN, errores 5xx, robots.txt…), si Google ha elegido otra canonical y cuándo la rastreó. Solo funciona con webs a las que tengas acceso en Search Console, hasta 2.000 URLs al día por propiedad. Los resultados se guardan con la auditoría.

**Conexión rápida:** si la carpeta de la herramienta tiene el archivo `google-client.json` (el cliente OAuth de la herramienta, que no se sube a GitHub y te pasa quien la administra), basta con **Ajustes (⚙) → Conectar con Google Search Console**, elegir tu cuenta y pulsar **Permitir**. En un servidor, ese cliente va en las variables de entorno `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.

Si no tienes ese archivo, se configura en el mismo proyecto de Google Cloud que la clave de CrUX. Primero, en **APIs y servicios → Biblioteca**, habilita **Google Search Console API**. Después elige una opción:

**Con tu cuenta de Google** (Ajustes → «Con tu propio cliente OAuth»):

1. En **APIs y servicios → Pantalla de consentimiento de OAuth**, configúrala como **Externa** y añade tu correo.
2. En **Público** (o «Estado de publicación»), pulsa **Publicar aplicación** para pasarla a **En producción**. Si se queda «En pruebas», Google desconecta la herramienta cada 7 días. Al conectar verás el aviso «Google no ha verificado esta aplicación»: es tu propia app, pulsa *Configuración avanzada → Ir a…*.
3. En **Credenciales → Crear credenciales → ID de cliente de OAuth**, elige **Aplicación de escritorio**.
4. En la herramienta, **Ajustes (⚙) → Google Search Console → Con tu cuenta de Google**: pega el ID de cliente y el secreto y pulsa **Conectar con Google**.

**Con cuenta de servicio** (recomendado para equipos y para el servidor; no caduca):

1. En **IAM y administración → Cuentas de servicio**, crea una cuenta y, en **Claves → Agregar clave → JSON**, descarga su archivo.
2. En Search Console, en cada propiedad: **Configuración → Usuarios y permisos → Añadir usuario**, con el correo de la cuenta de servicio (`…@….iam.gserviceaccount.com`) y permiso **Restringido**.
3. En la herramienta, **Ajustes → Google Search Console → Con cuenta de servicio**: pega el contenido del .json y guarda.

Las credenciales se guardan solo en tu equipo (`settings.json`, que no se sube a git).

## Renderizado para Google (opcional)

Marca **Comprobar renderizado para Google** al lanzar una auditoría, o pulsa el botón del mismo nombre en una ya hecha. Al terminar la auditoría (para no falsear las mediciones de rendimiento), comprueba en cada URL:

- **Recursos bloqueados por robots.txt:** JS, CSS y peticiones de datos **del propio sitio** que Googlebot no puede descargar según las reglas de Google (los de otros dominios se ignoran: su robots.txt no depende de ti) (grupo de Googlebot o `*`, la regla más larga gana). Sin ellos Google puede ver la página rota.
- **HTML inicial frente a renderizado:** si la meta robots, la canonical, el título, el H1, los enlaces internos o el texto solo aparecen (o cambian) al ejecutar JavaScript.
- **Indexabilidad:** errores HTTP, `noindex` en la meta robots o en la cabecera `X-Robots-Tag` y canonical que apunta a otra URL.
- **Contenido oculto por CSS:** renderiza como Google (pantalla tan alta como la página, sin scroll ni clics) y mide el texto principal invisible (`opacity`, `visibility`, `display:none`). Después interactúa como una persona (ratón y rueda) para distinguir lo que **solo aparece al interactuar** —Googlebot no interactúa; causa habitual: animaciones de entrada con «Retrasar JavaScript» de WP Rocket, LiteSpeed o Perfmatters— de carruseles, pestañas y efectos. Fiabilidad media: el renderizador de Google no se puede reproducir exacto.

Imita el renderizado de Google: cada URL en un contexto limpio (sin cookies, caché ni service workers), pantalla de Googlebot smartphone, espera a que la página se estabilice y animaciones CSS adelantadas, como hace Google. Aun así no es su vista real: no detecta bloqueos por IP ni sabe qué ha indexado Google (para eso, conecta Search Console). Añade entre 10 y 30 segundos por URL.

## Limitaciones

- Solo escucha en 127.0.0.1. No publicarlo en Internet sin autenticación, control de SSRF y colas.
- Máximo 2 auditorías simultáneas.
- Audita como máximo 200 URLs por sitio y, por defecto, 8 por tipo de página (muestreo de Unlighthouse). El panel avisa cuando se ha muestreado o se ha llegado al límite; «Opciones avanzadas → Auditar todas las URLs, sin muestreo» lo desactiva.
- No funciona en GitHub Pages: necesita un servidor con Node.js y Chrome.
- El idioma del informe solo cambia los textos; las mediciones son las de Lighthouse.

## Créditos

Motor: [Unlighthouse](https://github.com/harlan-zw/unlighthouse) (MIT, © Harlan Wilton y colaboradores) y [Google Lighthouse](https://github.com/GoogleChrome/lighthouse) (Apache-2.0), instalados como dependencias sin modificar.

Autora: [Alicia Ruiz](https://aliciaruiz.es/blog/). © 2026 Alicia Ruiz. Todos los derechos reservados: uso solo con autorización de la autora (ver `LICENSE`).
