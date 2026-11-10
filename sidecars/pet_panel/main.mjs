/**
 * Gemini Usage Pet Sidecar Backend (v0.3-pet-ui & v0.4-sliders)
 * Tracks live token usage (Last Reply, This Chat, Last 5h, This Week) across all
 * Antigravity conversations in <appData>/brain/<convId>/.system_generated/logs/transcript.jsonl
 * and persists Quick-Sync plan quota sliders to disk.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
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

function getQuotaFilePath() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    try {
      mkdirSync(dataDir, { recursive: true });
      return join(dataDir, 'quotas.json');
    } catch {
      // Fallback to sidecar dir
    }
  }
  return join(__dirname, 'quotas.json');
}

const DEFAULT_QUOTAS = {
  geminiWeekly: 100,
  claudeWeekly: 100,
  claude5h: 100,
  gptWeekly: 100,
  gpt5h: 100,
  updatedAt: null,
};

function loadQuotas() {
  try {
    const raw = JSON.parse(readFileSync(getQuotaFilePath(), 'utf-8'));
    return {
      geminiWeekly: clampPct(raw.geminiWeekly, 100),
      claudeWeekly: clampPct(raw.claudeWeekly, 100),
      claude5h: clampPct(raw.claude5h, 100),
      gptWeekly: clampPct(raw.gptWeekly, 100),
      gpt5h: clampPct(raw.gpt5h, 100),
      updatedAt: raw.updatedAt || null,
    };
  } catch {
    return { ...DEFAULT_QUOTAS };
  }
}

function clampPct(val, fallback = 100) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function saveQuotas(params) {
  const current = loadQuotas();
  const next = {
    geminiWeekly: params.geminiWeekly !== undefined ? clampPct(params.geminiWeekly, current.geminiWeekly) : current.geminiWeekly,
    claudeWeekly: params.claudeWeekly !== undefined ? clampPct(params.claudeWeekly, current.claudeWeekly) : current.claudeWeekly,
    claude5h: params.claude5h !== undefined ? clampPct(params.claude5h, current.claude5h) : current.claude5h,
    gptWeekly: params.gptWeekly !== undefined ? clampPct(params.gptWeekly, current.gptWeekly) : current.gptWeekly,
    gpt5h: params.gpt5h !== undefined ? clampPct(params.gpt5h, current.gpt5h) : current.gpt5h,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(getQuotaFilePath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch {
    // Ignore write errors
  }
  return next;
}

// Per-conversation transcript cache: convId -> { mtimeMs, size, lastActiveMs, entries, lastTurn, chatTotals }
const transcriptCache = new Map();

function emptyBucket() {
  return { input: 0, cache: 0, output: 0, total: 0, steps: 0 };
}

function addTokens(bucket, inp, cache, out) {
  bucket.input += inp;
  bucket.cache += cache;
  bucket.output += out;
  bucket.total += inp + cache + out;
  bucket.steps += 1;
}

function parseTranscriptFile(filePath) {
  const entries = [];
  const chatTotals = emptyBucket();
  let currentTurn = emptyBucket();
  let lastNonEmptyTurn = emptyBucket();
  let lastStep = emptyBucket();
  let lastActiveMs = 0;

  let content = '';
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return { entries, chatTotals, lastTurn: lastNonEmptyTurn, lastStep, lastActiveMs };
  }

  const lines = content.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = obj.created_at ? Date.parse(obj.created_at) : NaN;
    if (Number.isFinite(ts) && ts > lastActiveMs) {
      lastActiveMs = ts;
    }

    if (obj.type === 'USER_INPUT') {
      currentTurn = emptyBucket();
      continue;
    }

    const inp = Number(obj.input_tokens) || 0;
    const cache = Number(obj.cache_read_tokens) || 0;
    const out = Number(obj.output_tokens) || 0;
    if (inp > 0 || cache > 0 || out > 0) {
      addTokens(chatTotals, inp, cache, out);
      addTokens(currentTurn, inp, cache, out);
      lastNonEmptyTurn = { ...currentTurn };
      lastStep = { input: inp, cache, output: out, total: inp + cache + out, steps: 1 };
      entries.push({
        ts: Number.isFinite(ts) ? ts : 0,
        input: inp,
        cache,
        output: out,
        total: inp + cache + out,
      });
    }
  }

  return {
    entries,
    chatTotals,
    lastTurn: currentTurn.total > 0 ? currentTurn : lastNonEmptyTurn,
    lastStep,
    lastActiveMs,
  };
}

function getConversationData(brainDir, convId) {
  const logsDir = join(brainDir, convId, '.system_generated', 'logs');
  let filePath = join(logsDir, 'transcript.jsonl');
  let st = safeStat(filePath);
  if (!st) {
    filePath = join(logsDir, 'transcript_full.jsonl');
    st = safeStat(filePath);
  }
  if (!st) return null;

  const cached = transcriptCache.get(convId);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached;
  }

  const parsed = parseTranscriptFile(filePath);
  const record = {
    convId,
    mtimeMs: st.mtimeMs,
    size: st.size,
    lastActiveMs: parsed.lastActiveMs || st.mtimeMs,
    entries: parsed.entries,
    chatTotals: parsed.chatTotals,
    lastTurn: parsed.lastTurn,
    lastStep: parsed.lastStep,
  };
  transcriptCache.set(convId, record);
  return record;
}

function computeUsageSummary(requestedConvId) {
  const now = Date.now();
  const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const last5h = emptyBucket();
  const thisWeek = emptyBucket();
  const allTime = emptyBucket();

  const appDataDirs = findAppDataDirs();
  const allConvs = [];

  for (const appData of appDataDirs) {
    const brainDir = join(appData, 'brain');
    const convIds = safeReaddir(brainDir);
    for (const convId of convIds) {
      const rec = getConversationData(brainDir, convId);
      if (!rec) continue;
      allConvs.push(rec);

      for (const e of rec.entries) {
        addTokens(allTime, e.input, e.cache, e.output);
        if (e.ts >= sevenDaysAgo) {
          addTokens(thisWeek, e.input, e.cache, e.output);
        }
        if (e.ts >= fiveHoursAgo) {
          addTokens(last5h, e.input, e.cache, e.output);
        }
      }
    }
  }

  let activeRec = null;
  if (requestedConvId) {
    activeRec = allConvs.find((c) => c.convId === requestedConvId) || null;
  }
  if (!activeRec && allConvs.length > 0) {
    const withTokens = allConvs.filter((c) => c.chatTotals.total > 0);
    const pool = withTokens.length > 0 ? withTokens : allConvs;
    pool.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
    activeRec = pool[0];
  }

  return {
    ok: true,
    version: '0.3.0 (v0.3-pet-ui)',
    conversationId: activeRec ? activeRec.convId : requestedConvId || null,
    conversationCount: allConvs.length,
    currentChat: activeRec
      ? {
          convId: activeRec.convId,
          totals: activeRec.chatTotals,
          lastTurn: activeRec.lastTurn,
          lastStep: activeRec.lastStep,
          lastActiveMs: activeRec.lastActiveMs,
        }
      : {
          convId: null,
          totals: emptyBucket(),
          lastTurn: emptyBucket(),
          lastStep: emptyBucket(),
          lastActiveMs: 0,
        },
    last5h,
    thisWeek,
    allTime,
    quotas: loadQuotas(),
    updatedAt: new Date(now).toISOString(),
  };
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
  '/api/usage',
  (data) => {
    const conv = data?.conversationId || app.config?.conversationId || '';
    return computeUsageSummary(conv);
  },
  'GET'
);

app.api(
  '/api/save-quotas',
  (data) => {
    return { ok: true, quotas: saveQuotas(data || {}) };
  },
  'GET'
);

app.api(
  '/api/status',
  (data) => {
    const conv = data?.conversationId || app.config?.conversationId || '';
    return computeUsageSummary(conv);
  },
  'GET'
);

app.run();
