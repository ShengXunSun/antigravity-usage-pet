/**
 * Gemini Usage Pet Sidecar Backend (v0.5-context-window)
 * Tracks live token usage (Last Reply, This Chat, Last 5h, This Week),
 * Input/Cache/Output breakdowns, and Current Chat Context Window usage + hover composition
 * across all Antigravity conversations in <appData>/brain/<convId>/.system_generated/logs/transcript.jsonl
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

// Per-conversation transcript cache
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

const MODEL_CHANGE_RE = /changed setting `Model Selection` from .+ to ([^.\r\n]+)\./i;
const TRUNCATED_RE = /<truncated (\d+) bytes>/g;

function trueCharLength(val) {
  if (!val) return 0;
  const s = typeof val === 'string' ? val : JSON.stringify(val);
  let extra = 0;
  for (const m of s.matchAll(TRUNCATED_RE)) {
    extra += Number(m[1]) || 0;
  }
  return s.length + extra;
}

function inferContextLimit(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (m.includes('gemini')) return 1_000_000;
  if (m.includes('claude')) return 200_000;
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 200_000;
  return 200_000;
}

function parseTranscriptFile(filePath) {
  const entries = [];
  const chatTotals = emptyBucket();
  let currentTurn = emptyBucket();
  let lastNonEmptyTurn = emptyBucket();
  let lastStep = emptyBucket();
  let lastActiveMs = 0;
  let activeModel = '';

  let firstStepPromptTokens = 0;
  let firstUserChars = 0;
  let msgChars = 0;
  let toolChars = 0;
  let thinkingChars = 0;

  let content = '';
  try {
    // Preserve <truncated N bytes> inline while stripping raw newlines around it so JSON.parse succeeds
    content = readFileSync(filePath, 'utf-8').replace(/\r?\n(<truncated \d+ bytes>)\r?\n/g, ' $1 ');
  } catch {
    return {
      entries,
      chatTotals,
      lastTurn: lastNonEmptyTurn,
      lastStep,
      lastActiveMs,
      activeModel,
      contextBreakdown: {
        toolsTokens: 0,
        messagesTokens: 0,
        systemTokens: 0,
        thinkingTokens: 0,
        toolsPct: 0,
        messagesPct: 0,
        systemPct: 0,
        thinkingPct: 0,
      },
    };
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
      const cLen = trueCharLength(obj.content);
      msgChars += cLen;
      if (firstStepPromptTokens === 0 && firstUserChars === 0) {
        firstUserChars = cLen;
      }
      if (Array.isArray(obj.media) && obj.media.length > 0) {
        // Attached media / images count toward messages/media context (~1200 chars eq per image)
        msgChars += obj.media.length * 4000;
      }
      if (typeof obj.content === 'string') {
        const match = MODEL_CHANGE_RE.exec(obj.content);
        if (match && match[1]) {
          activeModel = match[1].trim();
        }
      }
      continue;
    }

    if (obj.type === 'GENERIC') {
      toolChars += trueCharLength(obj.content);
      continue;
    }

    if (obj.type === 'PLANNER_RESPONSE') {
      msgChars += trueCharLength(obj.content);
      thinkingChars += trueCharLength(obj.thinking);
      if (obj.tool_calls) {
        toolChars += trueCharLength(obj.tool_calls);
      }
    }

    const inp = Number(obj.input_tokens) || 0;
    const cache = Number(obj.cache_read_tokens) || 0;
    const out = Number(obj.output_tokens) || 0;
    if (inp > 0 || cache > 0 || out > 0) {
      if (firstStepPromptTokens === 0) {
        firstStepPromptTokens = inp + cache;
      }
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

  // Compute exact Context Window composition for the latest step
  const totalCtx = lastStep.total;
  let contextBreakdown;
  if (totalCtx <= 0) {
    contextBreakdown = {
      toolsTokens: 0,
      messagesTokens: 0,
      systemTokens: 0,
      thinkingTokens: 0,
      toolsPct: 0,
      messagesPct: 0,
      systemPct: 0,
      thinkingPct: 0,
    };
  } else {
    const firstMsgTokens = Math.min(2000, Math.round(firstUserChars / 4));
    const baseSys = firstStepPromptTokens > 0 ? Math.max(4000, firstStepPromptTokens - firstMsgTokens) : 15500;
    const systemTokens = Math.min(totalCtx, baseSys);
    const dynamicCtx = Math.max(0, totalCtx - systemTokens);

    const totalDynamicChars = Math.max(1, msgChars + toolChars + thinkingChars);
    const toolsTokens = Math.round(dynamicCtx * (toolChars / totalDynamicChars));
    const messagesTokens = Math.round(dynamicCtx * (msgChars / totalDynamicChars));
    const thinkingTokens = Math.max(0, dynamicCtx - toolsTokens - messagesTokens);

    const toolsPct = Math.round((toolsTokens / totalCtx) * 100);
    const messagesPct = Math.round((messagesTokens / totalCtx) * 100);
    const systemPct = Math.round((systemTokens / totalCtx) * 100);
    const thinkingPct = Math.max(0, 100 - toolsPct - messagesPct - systemPct);

    contextBreakdown = {
      toolsTokens,
      messagesTokens,
      systemTokens,
      thinkingTokens,
      toolsPct,
      messagesPct,
      systemPct,
      thinkingPct,
    };
  }

  return {
    entries,
    chatTotals,
    lastTurn: currentTurn.total > 0 ? currentTurn : lastNonEmptyTurn,
    lastStep,
    lastActiveMs,
    activeModel,
    contextBreakdown,
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
    activeModel: parsed.activeModel,
    contextBreakdown: parsed.contextBreakdown,
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

  const activeModel = activeRec?.activeModel || '';
  const contextLimit = inferContextLimit(activeModel);

  return {
    ok: true,
    version: '0.5.0 (v0.5)',
    conversationId: activeRec ? activeRec.convId : requestedConvId || null,
    conversationCount: allConvs.length,
    currentChat: activeRec
      ? {
          convId: activeRec.convId,
          totals: activeRec.chatTotals,
          lastTurn: activeRec.lastTurn,
          lastStep: activeRec.lastStep,
          activeModel,
          contextLimit,
          contextBreakdown: activeRec.contextBreakdown,
          lastActiveMs: activeRec.lastActiveMs,
        }
      : {
          convId: null,
          totals: emptyBucket(),
          lastTurn: emptyBucket(),
          lastStep: emptyBucket(),
          activeModel: '',
          contextLimit: 200_000,
          contextBreakdown: {
            toolsTokens: 0,
            messagesTokens: 0,
            systemTokens: 0,
            thinkingTokens: 0,
            toolsPct: 0,
            messagesPct: 0,
            systemPct: 0,
            thinkingPct: 0,
          },
          lastActiveMs: 0,
        },
    last5h,
    thisWeek,
    allTime,
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
  '/nyaa.wav',
  () =>
    new Response(readFileSync(join(__dirname, 'nyaa.wav')), {
      contentType: 'audio/wav',
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
  '/api/status',
  (data) => {
    const conv = data?.conversationId || app.config?.conversationId || '';
    return computeUsageSummary(conv);
  },
  'GET'
);

app.run();
