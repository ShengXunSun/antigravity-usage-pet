/**
 * Gemini Usage Pet Sidecar Backend (v0.1-base)
 * Minimal sidecar skeleton to verify Aux Pane connection, conversationId detection,
 * and brain directory discovery.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_TEXT = {
  '/styles.css': ['styles.css', 'text/css'],
  '/app.js': ['app.js', 'application/javascript'],
};

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  const dirs = safeReaddir(root).sort().map((name) => join(root, name));
  return dirs.filter((c) => existsSync(join(c, 'brain')));
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, type]] of Object.entries(STATIC_TEXT)) {
  app.api(
    route,
    () =>
      new Response(readFileSync(join(__dirname, file), 'utf-8'), {
        contentType: type,
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' },
      }),
    'GET'
  );
}

app.api(
  '/pet.png',
  () =>
    new Response(readFileSync(join(__dirname, 'pet.png')), {
      contentType: 'image/png',
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' },
    }),
  'GET'
);

app.api(
  '/api/status',
  (data) => {
    const conv = data?.conversationId || app.config?.conversationId || '';
    const appDataDirs = findAppDataDirs();
    let conversationCount = 0;
    for (const dir of appDataDirs) {
      conversationCount += safeReaddir(join(dir, 'brain')).length;
    }
    return {
      ok: true,
      version: '0.1.1 (v0.1-base)',
      conversationId: conv || null,
      appDataFound: appDataDirs.length > 0,
      conversationCount,
      updatedAt: new Date().toISOString(),
    };
  },
  'GET'
);

app.run();
