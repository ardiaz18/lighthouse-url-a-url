// Cliente OAuth de la herramienta para el botón «Conectar con Google Search Console».
// Las credenciales no se suben a git: se leen de las variables de entorno GOOGLE_CLIENT_ID y
// GOOGLE_CLIENT_SECRET (servidor) o del archivo local google-client.json (equipo), con la forma
// { "clientId": "….apps.googleusercontent.com", "clientSecret": "GOCSPX-…" }.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function googleClient(root) {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
  const file = await readFile(join(root, 'google-client.json'), 'utf-8').then(JSON.parse).catch(() => null);
  return file?.clientId && file?.clientSecret ? { clientId: file.clientId, clientSecret: file.clientSecret } : null;
}
