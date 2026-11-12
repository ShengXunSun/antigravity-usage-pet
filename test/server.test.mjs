import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const mainMjs = join(repoRoot, 'sidecars', 'pet_panel', 'main.mjs');
const sdkNodeModules = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules');

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
    srv.on('error', reject);
  });
}

test('SidecarApp HTTP integration enforces POST auth, serves immutable hashed assets, and short-circuits unchanged polls', async (t) => {
  if (!existsSync(join(sdkNodeModules, 'sidecar_sdk'))) {
    t.skip('sidecar_sdk not installed in ~/.gemini/antigravity/lib/node_modules');
    return;
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), 'whale-pet-srv-'));
  const fakeSidecarData = join(tmpRoot, 'appData', 'sidecar_data', 'whale-pet', 'pet_panel');
  const brainConvLogs = join(tmpRoot, 'appData', 'brain', 'conv-alpha', '.system_generated', 'logs');
  mkdirSync(fakeSidecarData, { recursive: true });
  mkdirSync(brainConvLogs, { recursive: true });

  const nowIso = new Date().toISOString();
  writeFileSync(
    join(brainConvLogs, 'transcript.jsonl'),
    [
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: nowIso,
        content:
          '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Claude Sonnet 5.5 (High). No need to comment.\n</USER_SETTINGS_CHANGE>',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: nowIso,
        input_tokens: 10000,
        cache_read_tokens: 30000,
        output_tokens: 800,
        content: 'Hello from Claude',
      }),
    ].join('\n') + '\n',
    'utf-8'
  );

  const port = await getFreePort();
  const uiToken = 'secret-test-ui-token-123';
  const sdkIndexUrl = pathToFileURL(join(sdkNodeModules, 'sidecar_sdk', 'index.mjs')).href;
  const loaderHook = `import { registerHooks } from 'node:module'; registerHooks({ resolve(s, ctx, next) { return s === 'sidecar_sdk' ? { url: ${JSON.stringify(sdkIndexUrl)}, shortCircuit: true } : next(s, ctx); } });`;
  const loaderDataUrl = `data:text/javascript;base64,${Buffer.from(loaderHook).toString('base64')}`;

  const child = spawn(process.execPath, ['--import', loaderDataUrl, mainMjs], {
    env: {
      ...process.env,
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9',
      ANTIGRAVITY_CSRF_TOKEN: 'csrf-test',
      ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
      ANTIGRAVITY_SIDECAR_UI_TOKEN: uiToken,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: fakeSidecarData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error('sidecar startup timed out')), 5000);
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.stdout.on('data', (d) => {
        if (d.toString().includes('[sidecar] listening')) {
          clearTimeout(timeout);
          resolveReady();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        rejectReady(new Error(`sidecar exited early (${code}): ${stderr}`));
      });
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get('cache-control') || '', /no-store/);
    const html = await htmlRes.text();
    assert.ok(!html.includes('/preload.js'), 'preload.js removed so agentapi is never spawned on load');
    assert.ok(!html.includes('__ASSET_VER__'), 'asset version placeholder resolved');
    assert.ok(!html.includes('src="/pet.png'), 'initial img src omitted to prevent double sprite download on Claude chats');

    const verMatch = /\/app\.js\?v=([0-9a-f]{10})/.exec(html);
    assert.ok(verMatch, 'expected 10-char hex asset hash in HTML');
    const assetVer = verMatch[1];

    const v21Res = await fetch(`${baseUrl}/v21`);
    assert.equal(v21Res.status, 200, 'legacy /v21 route still serves index HTML for seamless reload');

    const jsRes = await fetch(`${baseUrl}/app.js?v=${assetVer}`);
    assert.equal(jsRes.status, 200);
    assert.equal(jsRes.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const jsBody = await jsRes.text();
    assert.ok(jsBody.length < 20_000, `expected lean app.js < 20 KB without NYAA_B64, got ${jsBody.length}`);

    const wavRes = await fetch(`${baseUrl}/nyaa.wav?v=${assetVer}`);
    assert.equal(wavRes.status, 200);
    assert.equal(wavRes.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const wavBytes = await wavRes.arrayBuffer();
    assert.equal(wavBytes.byteLength, readFileSync(join(repoRoot, 'sidecars', 'pet_panel', 'nyaa.wav')).length);

    const legacyGetRes1 = await fetch(`${baseUrl}/api/usage`);
    assert.equal(legacyGetRes1.status, 200);
    const legacyGetJson1 = await legacyGetRes1.json();
    const legacyGetJson2 = await (await fetch(`${baseUrl}/api/usage`)).json();
    assert.equal(legacyGetJson1.ok, true);
    assert.equal(legacyGetJson1.reloadRequired, undefined, 'no unread reloadRequired property on legacy GET');
    assert.notEqual(
      legacyGetJson1.assetVersion,
      legacyGetJson2.assetVersion,
      'changing assetVersion forces even freshly mounted pre-v0.8 iframes (loadedAssetVer=null) to reload on poll 2'
    );
    assert.equal(legacyGetJson1.currentChat, undefined, 'unauthenticated GET exposes zero conversation data');

    const unauthPost = await fetch(`${baseUrl}/api/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthPost.status, 401, 'POST /api/usage without X-Sidecar-Token returns 401');

    const authPost = await fetch(`${baseUrl}/api/usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': uiToken,
      },
      body: JSON.stringify({ conversationId: 'conv-alpha' }),
    });
    assert.equal(authPost.status, 200);
    const summary = await authPost.json();
    assert.equal(summary.version, '0.8.0');
    assert.equal(summary.assetVersion, assetVer);
    assert.equal(summary.currentChat.activeModel, 'Claude Sonnet 5.5 (High)');
    assert.equal(summary.currentChat.contextLimit, 200_000);
    assert.equal(summary.currentChat.totals.total, 40_800);
    assert.equal(summary.daily.replies, 1);

    const authShortCircuit = await fetch(`${baseUrl}/api/usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': uiToken,
      },
      body: JSON.stringify({
        conversationId: 'conv-alpha',
        sinceRev: summary.rev,
        sinceConvId: 'conv-alpha',
      }),
    });
    assert.equal(authShortCircuit.status, 200);
    const shortJson = await authShortCircuit.json();
    assert.equal(shortJson.unchanged, true);
    assert.equal(shortJson.rev, summary.rev);
  } finally {
    child.kill();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('every DOM element ID queried in app.js exists in index.html and zero stale 5h IDs remain', () => {
  const html = readFileSync(join(repoRoot, 'sidecars', 'pet_panel', 'index.html'), 'utf-8');
  const js = readFileSync(join(repoRoot, 'sidecars', 'pet_panel', 'app.js'), 'utf-8');

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(jsIds.length >= 25, `expected at least 25 cached DOM IDs, found ${jsIds.length}`);
  for (const id of jsIds) {
    assert.ok(htmlIds.has(id), `app.js queries #${id} which is missing from index.html`);
  }
  assert.ok(!htmlIds.has('val-5h') && !htmlIds.has('sub-5h'), 'stale 5h DOM IDs removed');
});
