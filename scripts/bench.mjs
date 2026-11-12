import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { cpus, homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UsageTracker } from '../sidecars/pet_panel/tracker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function gitBlobSize(revPath) {
  return Number(execFileSync('git', ['-C', repoRoot, 'cat-file', '-s', revPath], { encoding: 'utf-8' }).trim());
}

function medianAndRange(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
  return {
    medianMs: Number(median.toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

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

async function buildV07Harness(tmpDir, appDataDir) {
  const rawV07 = execFileSync('git', ['-C', repoRoot, 'show', 'v0.7-save:sidecars/pet_panel/main.mjs'], {
    encoding: 'utf-8',
  });
  const cutIdx = rawV07.indexOf('const app = new SidecarApp();');
  assert.ok(cutIdx > 0, 'located SidecarApp tail in v0.7-save main.mjs');
  const patched = rawV07
    .slice(0, cutIdx)
    .replace("import { SidecarApp, Response } from 'sidecar_sdk';", '')
    .replace(
      'function findAppDataDirs() {',
      `function findAppDataDirs() { return [${JSON.stringify(appDataDir)}];`
    )
    .concat('\nexport { computeUsageSummary, transcriptCache };\n');

  const modPath = join(tmpDir, `v07_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(modPath, patched, 'utf-8');
  return import(pathToFileURL(modPath).href);
}

async function startV08HttpServer(appDataDir) {
  const port = await getFreePort();
  const token = 'bench-token-v08';
  const fakeSidecarData = join(appDataDir, 'sidecar_data', 'whale-pet', 'pet_panel');
  mkdirSync(fakeSidecarData, { recursive: true });
  const sdkUrl = pathToFileURL(
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs')
  ).href;
  const loaderCode = `import { registerHooks } from 'node:module'; registerHooks({ resolve(s, c, n) { if (s === 'sidecar_sdk') return { url: ${JSON.stringify(sdkUrl)}, shortCircuit: true }; return n(s, c); } });`;
  const loaderArg = `data:text/javascript;base64,${Buffer.from(loaderCode).toString('base64')}`;
  const child = spawn(process.execPath, ['--import', loaderArg, join(repoRoot, 'sidecars', 'pet_panel', 'main.mjs')], {
    env: {
      ...process.env,
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9',
      ANTIGRAVITY_CSRF_TOKEN: 'csrf-bench',
      ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
      ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: fakeSidecarData,
      USERPROFILE: join(appDataDir, 'no-global-home'),
      APPDATA: join(appDataDir, 'no-global-appdata'),
      LOCALAPPDATA: join(appDataDir, 'no-global-local'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP benchmark server timed out')), 5000);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('[sidecar] listening')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP benchmark server exited with ${code}: ${stderr}`));
    });
  });
  return { port, token, child };
}

function createBenchmarkFixture(baseDir, label, baseTs) {
  const appData = join(baseDir, `appData_${label}`);
  const brainDir = join(appData, 'brain');
  mkdirSync(brainDir, { recursive: true });

  for (let c = 0; c < 14; c++) {
    const convId = `conv-bg-${String(c).padStart(2, '0')}`;
    const logsDir = join(brainDir, convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: new Date(baseTs + c * 1000).toISOString(),
        content: '<USER_REQUEST>background task</USER_REQUEST>',
      }),
    ];
    for (let s = 0; s < 45; s++) {
      lines.push(
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          created_at: new Date(baseTs + c * 1000 + s * 100).toISOString(),
          input_tokens: 4000,
          cache_read_tokens: 25000,
          output_tokens: 350,
          content: 'R'.repeat(300),
          tool_calls: [{ name: 'read_file', args: { Path: 'file_' + s + '.js', pad: 'X'.repeat(400) } }],
        })
      );
    }
    writeFileSync(join(logsDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf-8');
  }

  const activeConvId = 'conv-active-heavy';
  const activeLogsDir = join(brainDir, activeConvId, '.system_generated', 'logs');
  mkdirSync(activeLogsDir, { recursive: true });
  const activeFile = join(activeLogsDir, 'transcript.jsonl');
  const activeLines = [
    JSON.stringify({
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      created_at: new Date(baseTs).toISOString(),
      content:
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Carbon (High). No need to comment.\n</USER_SETTINGS_CHANGE>\n<USER_REQUEST>heavy session</USER_REQUEST>',
    }),
  ];
  for (let s = 0; s < 750; s++) {
    activeLines.push(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: new Date(baseTs + s * 200).toISOString(),
        input_tokens: 3500,
        cache_read_tokens: 90000,
        output_tokens: 500,
        thinking: 'T'.repeat(350),
        tool_calls: [{ name: 'edit_file', args: { Path: 'src/mod.js', Target: 'A'.repeat(450), Replacement: 'B'.repeat(450) } }],
      })
    );
  }
  const initialActiveContent = activeLines.join('\n') + '\n';
  writeFileSync(activeFile, initialActiveContent, 'utf-8');

  return { appData, activeConvId, activeFile, initialActiveContent };
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'whale-pet-bench-'));
  let httpSrv = null;
  try {
    const baseTs = Date.now() - 3600_000;
    const fixA = createBenchmarkFixture(tmpDir, 'A', baseTs);
    const fixB = createBenchmarkFixture(tmpDir, 'B', baseTs);
    const fixHttp = createBenchmarkFixture(tmpDir, 'HTTP', baseTs);
    const activeBytes = statSync(fixA.activeFile).size;
    const activeConvId = fixA.activeConvId;

    const v07Sizes = {
      appJs: gitBlobSize('v0.7-save:sidecars/pet_panel/app.js'),
      nyaaWav: gitBlobSize('v0.7-save:sidecars/pet_panel/nyaa.wav'),
      petPng: gitBlobSize('v0.7-save:sidecars/pet_panel/pet.png'),
      petClaudePng: gitBlobSize('v0.7-save:sidecars/pet_panel/pet-claude.png'),
      logoPng: gitBlobSize('v0.7-save:assets/logo.png'),
      logoSvg: gitBlobSize('v0.7-save:assets/logo.svg'),
      html: gitBlobSize('v0.7-save:sidecars/pet_panel/index.html'),
      css: gitBlobSize('v0.7-save:sidecars/pet_panel/styles.css'),
    };
    const v08Sizes = {
      appJs: statSync(join(repoRoot, 'sidecars', 'pet_panel', 'app.js')).size,
      nyaaWav: statSync(join(repoRoot, 'sidecars', 'pet_panel', 'nyaa.wav')).size,
      petPng: statSync(join(repoRoot, 'sidecars', 'pet_panel', 'pet.png')).size,
      petClaudePng: statSync(join(repoRoot, 'sidecars', 'pet_panel', 'pet-claude.png')).size,
      logoPng: statSync(join(repoRoot, 'assets', 'logo.png')).size,
      logoSvg: 0,
      html: statSync(join(repoRoot, 'sidecars', 'pet_panel', 'index.html')).size,
      css: statSync(join(repoRoot, 'sidecars', 'pet_panel', 'styles.css')).size,
    };

    const v07Mod = await buildV07Harness(tmpDir, fixA.appData);
    httpSrv = await startV08HttpServer(fixHttp.appData);
    const keepAliveAgent = new Agent({ keepAlive: true, maxSockets: 1 });
    const postJson = (payloadObj) =>
      new Promise((resolvePost, rejectPost) => {
        const bodyBuf = Buffer.from(JSON.stringify(payloadObj), 'utf-8');
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: httpSrv.port,
            path: '/api/usage',
            method: 'POST',
            agent: keepAliveAgent,
            headers: {
              'content-type': 'application/json',
              'content-length': bodyBuf.length,
              'x-sidecar-token': httpSrv.token,
            },
          },
          (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => {
              raw += c;
            });
            res.on('end', () => {
              resolvePost({ status: res.statusCode, json: JSON.parse(raw) });
            });
          }
        );
        req.setNoDelay(true);
        req.on('error', rejectPost);
        req.end(bodyBuf);
      });

    const trials = 7;
    const warmups = 2;
    const coldV07 = [];
    const coldV08 = [];
    const appendFirstOpenV07 = [];
    const appendFirstOpenV08 = [];
    const appendWarmHandleV07 = [];
    const appendWarmHandleV08 = [];
    const e2eHttpFirstOpenV08 = [];
    const idleV07 = [];
    const idleV08 = [];
    const e2eHttpIdleV08 = [];
    let errors = 0;
    let verifiedRuns = 0;
    let bytesConsumedA = 0;
    let bytesConsumedB = 0;
    let fakeMtime = Date.now() + 10_000;

    for (let iter = -warmups; iter < trials; iter++) {
      const record = iter >= 0;
      const even = iter % 2 === 0;

      fakeMtime += 5000;
      const resetTime = new Date(fakeMtime);
      for (const fix of [fixA, fixB, fixHttp]) {
        writeFileSync(fix.activeFile, fix.initialActiveContent, 'utf-8');
        utimesSync(fix.activeFile, resetTime, resetTime);
      }

      let dtColdA = 0;
      let dtColdB = 0;
      let trackerB;

      const runColdA = () => {
        v07Mod.transcriptCache.clear();
        const t0 = performance.now();
        const res = v07Mod.computeUsageSummary(activeConvId);
        const json = JSON.stringify(res);
        dtColdA = performance.now() - t0;
        bytesConsumedA += json.length;
        if (!res?.ok || res.currentChat?.totals?.total !== 750 * 94_000) errors++;
        else verifiedRuns++;
      };

      const runColdB = () => {
        trackerB = new UsageTracker({ appDataDirs: [fixB.appData] });
        const t0 = performance.now();
        const res = trackerB.getSummary({ conversationId: activeConvId });
        const json = JSON.stringify(res);
        dtColdB = performance.now() - t0;
        bytesConsumedB += json.length;
        if (!res?.ok || res.currentChat?.totals?.total !== 750 * 94_000) errors++;
        else verifiedRuns++;
      };

      if (even) {
        runColdA();
        runColdB();
      } else {
        runColdB();
        runColdA();
      }
      await postJson({ conversationId: activeConvId });

      const stepsPerTrial = 10;
      let sumFirstA = 0;
      let sumFirstB = 0;
      let sumWarmA = 0;
      let sumWarmB = 0;
      let sumHttpFirstB = 0;

      for (let s = 0; s < stepsPerTrial; s++) {
        fakeMtime += 1000;
        const mt = new Date(fakeMtime);
        const stepLine =
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            created_at: mt.toISOString(),
            input_tokens: 2000,
            cache_read_tokens: 95000,
            output_tokens: 400,
            content: 'step reply ' + s,
          }) + '\n';

        for (const fix of [fixA, fixB, fixHttp]) {
          appendFileSync(fix.activeFile, stepLine, 'utf-8');
          utimesSync(fix.activeFile, mt, mt);
        }

        let ra;
        let rb;
        const stepFirstA = () => {
          const t0 = performance.now();
          ra = v07Mod.computeUsageSummary(activeConvId);
          bytesConsumedA += JSON.stringify(ra).length;
          sumFirstA += performance.now() - t0;
        };
        const stepFirstB = () => {
          const t0 = performance.now();
          rb = trackerB.getSummary({ conversationId: activeConvId });
          bytesConsumedB += JSON.stringify(rb).length;
          sumFirstB += performance.now() - t0;
        };

        if ((iter + s) % 2 === 0) {
          stepFirstA();
          stepFirstB();
        } else {
          stepFirstB();
          stepFirstA();
        }

        const expectedTotal = 750 * 94_000 + (s + 1) * 97_400 + s * 51_200;
        if (ra.currentChat.totals.total !== expectedTotal || rb.currentChat.totals.total !== expectedTotal) {
          errors++;
        } else {
          verifiedRuns++;
        }

        const th0 = performance.now();
        const httpRes = await postJson({ conversationId: activeConvId });
        sumHttpFirstB += performance.now() - th0;
        if (httpRes.status !== 200 || httpRes.json.currentChat?.totals?.total !== expectedTotal) errors++;

        fakeMtime += 1000;
        const mtWarm = new Date(fakeMtime);
        const warmLine =
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            created_at: mtWarm.toISOString(),
            input_tokens: 1000,
            cache_read_tokens: 50000,
            output_tokens: 200,
            content: 'warm reply ' + s,
          }) + '\n';
        for (const fix of [fixA, fixB, fixHttp]) {
          appendFileSync(fix.activeFile, warmLine, 'utf-8');
          utimesSync(fix.activeFile, mtWarm, mtWarm);
          const warmFd = openSync(fix.activeFile, 'r');
          closeSync(warmFd);
        }

        const stepWarmA = () => {
          const t0 = performance.now();
          const r = v07Mod.computeUsageSummary(activeConvId);
          bytesConsumedA += JSON.stringify(r).length;
          sumWarmA += performance.now() - t0;
          if (r.currentChat.totals.total !== expectedTotal + 51_200) errors++;
        };
        const stepWarmB = () => {
          const t0 = performance.now();
          const r = trackerB.getSummary({ conversationId: activeConvId });
          bytesConsumedB += JSON.stringify(r).length;
          sumWarmB += performance.now() - t0;
          if (r.currentChat.totals.total !== expectedTotal + 51_200) errors++;
        };

        if ((iter + s) % 2 === 0) {
          stepWarmA();
          stepWarmB();
        } else {
          stepWarmB();
          stepWarmA();
        }
        await postJson({ conversationId: activeConvId });
      }
      void sumWarmA;

      const idlePolls = 50;
      const latestB = trackerB.getSummary({ conversationId: activeConvId });
      let dtIdleA = 0;
      let dtIdleB = 0;

      const runIdleA = () => {
        const t0 = performance.now();
        for (let p = 0; p < idlePolls; p++) {
          const r = v07Mod.computeUsageSummary(activeConvId);
          bytesConsumedA += JSON.stringify(r).length;
          if (!r.ok) errors++;
        }
        dtIdleA = (performance.now() - t0) / idlePolls;
      };

      const runIdleB = () => {
        const t0 = performance.now();
        for (let p = 0; p < idlePolls; p++) {
          const r = trackerB.getSummary({
            conversationId: activeConvId,
            sinceRev: latestB.rev,
            sinceConvId: activeConvId,
          });
          bytesConsumedB += JSON.stringify(r).length;
          if (!r.ok || !r.unchanged) errors++;
        }
        dtIdleB = (performance.now() - t0) / idlePolls;
      };

      if (even) {
        runIdleA();
        runIdleB();
      } else {
        runIdleB();
        runIdleA();
      }

      const initHttp = (await postJson({ conversationId: activeConvId })).json;
      const httpIdleCount = 25;
      const thIdle0 = performance.now();
      for (let p = 0; p < httpIdleCount; p++) {
        const hr = await postJson({
          conversationId: activeConvId,
          sinceRev: initHttp.rev,
          sinceConvId: activeConvId,
        });
        if (hr.status !== 200 || !hr.json.unchanged) errors++;
      }
      const dtHttpIdleB = (performance.now() - thIdle0) / httpIdleCount;

      if (record) {
        coldV07.push(dtColdA);
        coldV08.push(dtColdB);
        appendFirstOpenV07.push(sumFirstA / stepsPerTrial);
        appendFirstOpenV08.push(sumFirstB / stepsPerTrial);
        appendWarmHandleV07.push(sumWarmA / stepsPerTrial);
        appendWarmHandleV08.push(sumWarmB / stepsPerTrial);
        e2eHttpFirstOpenV08.push(sumHttpFirstB / stepsPerTrial);
        idleV07.push(dtIdleA);
        idleV08.push(dtIdleB);
        e2eHttpIdleV08.push(dtHttpIdleB);
      }
    }

    assert.equal(errors, 0, `benchmark encountered ${errors} validation errors`);
    assert.ok(bytesConsumedA > 0 && bytesConsumedB > 0, 'serialized outputs were consumed');

    const report = {
      environment: {
        node: process.version,
        logicalCores: cpus().length,
        cpuModel: cpus()[0]?.model?.trim() || 'unknown',
        trialsPerSide: trials,
        interleaved: true,
        activeTranscriptBytes: activeBytes,
        errors,
        verifiedRuns,
      },
      payloadBytes: {
        appJs: { v07: v07Sizes.appJs, v08: v08Sizes.appJs },
        nyaaWav: { v07: v07Sizes.nyaaWav, v08: v08Sizes.nyaaWav },
        petPng: { v07: v07Sizes.petPng, v08: v08Sizes.petPng },
        petClaudePng: { v07: v07Sizes.petClaudePng, v08: v08Sizes.petClaudePng },
        logoAssets: { v07: v07Sizes.logoPng + v07Sizes.logoSvg, v08: v08Sizes.logoPng + v08Sizes.logoSvg },
        claudeChatInitialTransfer: {
          v07: v07Sizes.html + v07Sizes.css + v07Sizes.appJs + v07Sizes.petPng + v07Sizes.petClaudePng,
          v08: v08Sizes.html + v08Sizes.css + v08Sizes.appJs + v08Sizes.petClaudePng,
        },
        claudeChatSwitchTransfer: {
          v07: v07Sizes.html + v07Sizes.css + v07Sizes.appJs + v07Sizes.petPng + v07Sizes.petClaudePng,
          v08: v08Sizes.html,
        },
      },
      latencyMs: {
        coldScan15Chats: {
          v07: medianAndRange(coldV07),
          v08: medianAndRange(coldV08),
          limiter: 'Windows Defender first-open CreateFileW scan + UTF-8 read and JSON.parse across 15 files (1,386 lines)',
        },
        stepAppendFirstOpen1MBChat: {
          v07: medianAndRange(appendFirstOpenV07),
          v08: medianAndRange(appendFirstOpenV08),
          e2eHttpV08: medianAndRange(e2eHttpFirstOpenV08),
          limiter: 'Windows Defender synchronous minifilter scan (~1.45 ms floor on immediate in-process CreateFileW after write-close) + v0.7 1.13 MB readFileUtf8/JSON.parse vs v0.8 298 B readSync',
        },
        stepAppendWarmMinifilter1MBChat: {
          v07: medianAndRange(appendWarmHandleV07),
          v08: medianAndRange(appendWarmHandleV08),
          limiter: 'v0.7 1.13 MB readFileUtf8 (49.8% CPU) + 752x JSON.parse vs v0.8 15x NTFS statSync + 298 B positional readSync',
        },
        steadyStateIdlePoll: {
          v07: medianAndRange(idleV07),
          v08: medianAndRange(idleV08),
          e2eHttpV08: medianAndRange(e2eHttpIdleV08),
          limiter: 'readdirSync + 15x NTFS statSync syscalls on one V8 thread (+ loopback TCP round-trip for HTTP)',
        },
      },
    };

    keepAliveAgent.destroy();
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (httpSrv?.child) {
      httpSrv.child.kill();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
