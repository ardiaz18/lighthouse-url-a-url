# Technical SEO Report

Panel local (`npm run dev`, http://127.0.0.1:4173) que lanza Unlighthouse sin modificar y muestra el informe Lighthouse de cada URL.

- `src/server.mjs`: panel, API, prioridad por gravedad y exportaciones (`/api/export/md|csv/<dominio>/<id>`).
- `src/unlighthouse-runner.mjs`: réplica del CLI oficial; solo fija puerto interno y `locale: 'es'`.
- `src/crux.mjs`: datos de usuarios reales (CrUX API); clave en settings.json o CRUX_API_KEY.
- `src/render.mjs`: renderizado para Google (robots.txt de los recursos y HTML inicial frente a renderizado, con Chrome vía puppeteer-core).
- `src/gsc.mjs`: Search Console (API de Inspección de URLs) con OAuth de escritorio o cuenta de servicio; credenciales en settings.json.
- `src/actions.mjs`: «qué hacer» en español para las auditorías Lighthouse habituales.
- `public/index.html`: interfaz (estilo aliciaruiz.es).

No alterar mediciones ni configuración de Lighthouse más allá del idioma.

## Analizar auditorías

Los informes están en `.unlighthouse/<dominio>/<id>/reports/**/lighthouse.json`. Cuando la usuaria pida analizar una auditoría:

1. Lee primero el resumen: `curl http://127.0.0.1:4173/api/export/md/<dominio>/<id>` (o calcula lo mismo desde los JSON si el panel no está en marcha).
2. Abre `lighthouse.json` solo de las URLs de prioridad alta para ver detalles (`audits[id].details`).
3. Agrupa problemas por causa común (plantilla, recurso compartido), prioriza por impacto y esfuerzo y propone acciones concretas.
