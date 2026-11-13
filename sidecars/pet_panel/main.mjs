import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { UsageTracker } from './tracker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginManifest = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'plugin.json'), 'utf-8'));
const PLUGIN_VERSION = pluginManifest.version || '1.0.0';

const rawHtmlTemplate = readFileSync(join(__dirname, 'index.html'), 'utf-8');
const textAssets = {
  '/styles.css': [readFileSync(join(__dirname, 'styles.css'), 'utf-8'), 'text/css; charset=utf-8'],
  '/app.js': [readFileSync(join(__dirname, 'app.js'), 'utf-8'), 'application/javascript; charset=utf-8'],
};
const binaryAssets = {
  '/pet.png': [readFileSync(join(__dirname, 'pet.png')), 'image/png'],
  '/pet-claude.png': [readFileSync(join(__dirname, 'pet-claude.png')), 'image/png'],
  '/nyaa.wav': [readFileSync(join(__dirname, 'nyaa.wav')), 'audio/wav'],
};

const hashBuilder = createHash('sha256').update(PLUGIN_VERSION).update(rawHtmlTemplate);
for (const [body] of Object.values(textAssets)) hashBuilder.update(body);
for (const [buf] of Object.values(binaryAssets)) hashBuilder.update(buf);
const ASSET_VERSION = hashBuilder.digest('hex').slice(0, 10);

const renderedIndexHtml = rawHtmlTemplate.replaceAll('__ASSET_VER__', ASSET_VERSION);
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_STORE_CACHE = 'no-cache, no-store, must-revalidate';

const tracker = new UsageTracker({
  version: PLUGIN_VERSION,
  assetVersion: ASSET_VERSION,
});

const app = new SidecarApp();

const serveIndexPage = () =>
  new Response(renderedIndexHtml, {
    contentType: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': NO_STORE_CACHE },
  });

app.page('/', serveIndexPage);
app.page('/v21', serveIndexPage);

for (const [route, [body, contentType]] of Object.entries(textAssets)) {
  app.api(
    route,
    (data) =>
      new Response(body, {
        contentType,
        headers: { 'Cache-Control': data?.v === ASSET_VERSION ? IMMUTABLE_CACHE : 'no-cache' },
      }),
    'GET'
  );
}

for (const [route, [buf, contentType]] of Object.entries(binaryAssets)) {
  app.api(
    route,
    (data) =>
      new Response(buf, {
        contentType,
        headers: { 'Cache-Control': data?.v === ASSET_VERSION ? IMMUTABLE_CACHE : 'no-cache' },
      }),
    'GET'
  );
}

let legacyReloadSeq = 0;
const serveLegacyReloadToken = () => ({
  ok: true,
  assetVersion: `${ASSET_VERSION}-${++legacyReloadSeq}`,
});

app.api('/api/usage', serveLegacyReloadToken, 'GET');

app.api(
  '/api/usage',
  (data) => {
    const conv = data?.conversationId || app.config?.conversationId || '';
    const sinceRev = Number(data?.sinceRev) || 0;
    const sinceConvId = String(data?.sinceConvId || '');
    return tracker.getSummary({ conversationId: conv, sinceRev, sinceConvId });
  },
  'POST'
);

app.run();
