import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const RETENTION_MS = 8 * ONE_DAY_MS;
const HEAD_SIG_BYTES = 64;

const SETTINGS_BLOCK_RE = /<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/gi;
const MODEL_CHANGE_RE = /changed setting `Model Selection` from [^\r\n]+? to ([^\r\n]+?)\.\s*No need/gi;
const TRUNCATED_RE = /<truncated (\d+) bytes>/g;
const RAW_TRUNCATED_FIX_RE = /\r?\n(<truncated \d+ bytes>)\r?\n/g;

export function emptyBucket() {
  return { input: 0, cache: 0, output: 0, total: 0, steps: 0, replies: 0 };
}

export function addTokens(bucket, inp, cache, out, isNewReply = false) {
  bucket.input += inp;
  bucket.cache += cache;
  bucket.output += out;
  bucket.total += inp + cache + out;
  bucket.steps += 1;
  if (isNewReply) {
    bucket.replies += 1;
  }
}

function sumTruncatedBytes(str) {
  if (typeof str !== 'string' || !str.includes('<truncated ')) return 0;
  let extra = 0;
  for (const m of str.matchAll(TRUNCATED_RE)) {
    extra += Number(m[1]) || 0;
  }
  return extra;
}

export function trueCharLength(val) {
  if (!val) return 0;
  const s = typeof val === 'string' ? val : JSON.stringify(val);
  return s.length + sumTruncatedBytes(s);
}

export function extractLastModelChange(content) {
  if (typeof content !== 'string' || !content.includes('<USER_SETTINGS_CHANGE>')) {
    return '';
  }
  let found = '';
  for (const block of content.matchAll(SETTINGS_BLOCK_RE)) {
    const inner = block[1] || '';
    for (const m of inner.matchAll(MODEL_CHANGE_RE)) {
      if (m[1]) {
        found = m[1].trim();
      }
    }
  }
  return found;
}

export function inferContextLimit(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (m.includes('claude')) return 200_000;
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 200_000;
  return 1_000_000;
}

export function apportionPercentages(counts) {
  const total = counts.reduce((acc, v) => acc + Math.max(0, v), 0);
  if (total <= 0) {
    return counts.map(() => 0);
  }
  const floors = new Array(counts.length).fill(0);
  const remainders = [];
  let sumFloors = 0;
  for (let i = 0; i < counts.length; i++) {
    const v = Math.max(0, counts[i]);
    if (v <= 0) continue;
    const exact = (v / total) * 100;
    const fl = Math.floor(exact);
    floors[i] = fl;
    sumFloors += fl;
    remainders.push({ idx: i, rem: exact - fl, count: v });
  }
  let leftover = 100 - sumFloors;
  remainders.sort((a, b) => (b.rem !== a.rem ? b.rem - a.rem : b.count - a.count));
  for (let k = 0; k < remainders.length && leftover > 0; k++, leftover--) {
    floors[remainders[k].idx] += 1;
  }
  return floors;
}

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

export function discoverAppDataDirs(env = process.env, home = homedir()) {
  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      if (existsSync(join(appData, 'brain'))) {
        return [appData];
      }
    }
    if (existsSync(join(dataDir, 'brain'))) {
      return [dataDir];
    }
  }
  const root = join(home, '.gemini');
  return safeReaddir(root)
    .sort()
    .map((name) => join(root, name))
    .filter((candidate) => existsSync(join(candidate, 'brain')));
}

function estimateSystemTokens(firstStepPromptTokens, firstUserChars, checkpointCount) {
  const firstMsgTokens = Math.min(2000, Math.round(firstUserChars / 4));
  const rawSys = firstStepPromptTokens > 0 ? Math.max(4000, firstStepPromptTokens - firstMsgTokens) : 14500;
  return checkpointCount > 0 ? Math.min(rawSys, 14300) : rawSys;
}

function emptyBreakdown() {
  return {
    toolsTokens: 0,
    messagesTokens: 0,
    systemTokens: 0,
    thinkingTokens: 0,
    toolsPct: 0,
    messagesPct: 0,
    systemPct: 0,
    thinkingPct: 0,
  };
}

function buildContextBreakdown(state) {
  const totalCtx = state.lastStep.total;
  if (totalCtx <= 0) {
    return emptyBreakdown();
  }
  const baseSys = estimateSystemTokens(state.firstStepPromptTokens, state.firstUserChars, state.checkpointCount);
  const systemTokens = Math.min(totalCtx, baseSys);
  const dynamicCtx = Math.max(0, totalCtx - systemTokens);

  const totalDynamicChars = Math.max(1, state.msgChars + state.toolChars + state.thinkingChars);
  const toolsTokens = Math.round(dynamicCtx * (state.toolChars / totalDynamicChars));
  const messagesTokens = Math.round(dynamicCtx * (state.msgChars / totalDynamicChars));
  const thinkingTokens = Math.max(0, dynamicCtx - toolsTokens - messagesTokens);

  const [toolsPct, messagesPct, systemPct, thinkingPct] = apportionPercentages([
    toolsTokens,
    messagesTokens,
    systemTokens,
    thinkingTokens,
  ]);

  return {
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

function createConversationState(convId, filePath) {
  return {
    convId,
    filePath,
    mtimeMs: 0,
    size: 0,
    offset: 0,
    headSig: Buffer.alloc(0),
    seenAnyStep: false,
    isSubagent: false,
    chatTotals: emptyBucket(),
    currentTurn: emptyBucket(),
    turnHasReply: false,
    lastNonEmptyTurn: emptyBucket(),
    lastStep: emptyBucket(),
    lastActiveMs: 0,
    lastValidTs: 0,
    activeModel: '',
    compactedFrom: 0,
    checkpointCount: 0,
    firstStepPromptTokens: 0,
    firstUserChars: 0,
    msgChars: 0,
    toolChars: 0,
    thinkingChars: 0,
    entries: [],
    contextBreakdown: emptyBreakdown(),
  };
}

function applyTranscriptLine(state, rawLine, fallbackTs) {
  const trimmed = rawLine.trim();
  if (!trimmed) return;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    try {
      obj = JSON.parse(trimmed.replace(RAW_TRUNCATED_FIX_RE, ' $1 '));
    } catch {
      return;
    }
  }
  if (!obj || typeof obj !== 'object') return;

  if (!state.seenAnyStep) {
    state.seenAnyStep = true;
    state.isSubagent = obj.type === 'SYSTEM_MESSAGE' || obj.source === 'SYSTEM';
  }

  const parsedTs = obj.created_at ? Date.parse(obj.created_at) : NaN;
  if (Number.isFinite(parsedTs) && parsedTs > 0) {
    state.lastValidTs = parsedTs;
    if (parsedTs > state.lastActiveMs) {
      state.lastActiveMs = parsedTs;
    }
  }
  const effectiveTs = state.lastValidTs || fallbackTs;

  if (obj.type === 'USER_INPUT') {
    state.currentTurn = emptyBucket();
    state.turnHasReply = false;
    const cLen = trueCharLength(obj.content);
    state.msgChars += cLen;
    if (state.firstStepPromptTokens === 0 && state.firstUserChars === 0) {
      state.firstUserChars = cLen;
    }
    if (Array.isArray(obj.media) && obj.media.length > 0) {
      state.msgChars += obj.media.length * 4000;
    }
    const nextModel = extractLastModelChange(obj.content);
    if (nextModel) {
      state.activeModel = nextModel;
    }
    return;
  }

  if (obj.type === 'SYSTEM_MESSAGE') {
    if (state.currentTurn.total > 0) {
      state.currentTurn = emptyBucket();
      state.turnHasReply = false;
    }
    const cLen = trueCharLength(obj.content);
    state.msgChars += cLen;
    if (state.firstStepPromptTokens === 0 && state.firstUserChars === 0) {
      state.firstUserChars = cLen;
    }
    return;
  }

  if (obj.type === 'ERROR_MESSAGE') {
    state.msgChars += trueCharLength(obj.content);
    return;
  }

  if (obj.type === 'GENERIC') {
    state.toolChars += trueCharLength(obj.content);
    return;
  }

  if (obj.type === 'PLANNER_RESPONSE') {
    const contentRawLen = typeof obj.content === 'string' ? obj.content.length : 0;
    const thinkingRawLen = typeof obj.thinking === 'string' ? obj.thinking.length : 0;
    const contentTrunc = sumTruncatedBytes(obj.content);
    const thinkingTrunc = sumTruncatedBytes(obj.thinking);
    state.msgChars += contentRawLen + contentTrunc;
    state.thinkingChars += thinkingRawLen + thinkingTrunc;
    if (obj.tool_calls) {
      const lineTrunc = sumTruncatedBytes(trimmed);
      const toolTrunc = Math.max(0, lineTrunc - contentTrunc - thinkingTrunc);
      const estSerializedToolLen = Math.max(32, trimmed.length - contentRawLen - thinkingRawLen - 140);
      state.toolChars += estSerializedToolLen + toolTrunc;
    }
  }

  const inp = Number(obj.input_tokens) || 0;
  const cache = Number(obj.cache_read_tokens) || 0;
  const out = Number(obj.output_tokens) || 0;

  if (obj.type === 'CHECKPOINT') {
    const preCompactTotal = inp + cache + out;
    if (preCompactTotal > 0) {
      state.compactedFrom = preCompactTotal;
    }
    state.checkpointCount += 1;
    state.msgChars = Math.max(1200, trueCharLength(obj.content));
    state.toolChars = 0;
    state.thinkingChars = 0;

    if (preCompactTotal > 0) {
      if (state.firstStepPromptTokens === 0) {
        state.firstStepPromptTokens = inp + cache;
      }
      addTokens(state.chatTotals, inp, cache, out, false);
      state.entries.push({
        ts: effectiveTs,
        input: inp,
        cache,
        output: out,
        isNewReply: false,
      });
    }

    const baseSys = estimateSystemTokens(state.firstStepPromptTokens, state.firstUserChars, state.checkpointCount);
    const summaryTokens = Math.max(400, Math.round(state.msgChars / 4));
    const postCompactTotal = baseSys + summaryTokens;
    state.lastStep = {
      input: postCompactTotal,
      cache: 0,
      output: 0,
      total: postCompactTotal,
      steps: 1,
      replies: 0,
    };
    return;
  }

  if (inp > 0 || cache > 0 || out > 0) {
    if (state.firstStepPromptTokens === 0) {
      state.firstStepPromptTokens = inp + cache;
    }
    const isNewReply = !state.turnHasReply;
    state.turnHasReply = true;
    addTokens(state.chatTotals, inp, cache, out, isNewReply);
    addTokens(state.currentTurn, inp, cache, out, isNewReply);
    state.lastNonEmptyTurn = { ...state.currentTurn };
    state.lastStep = { input: inp, cache, output: out, total: inp + cache + out, steps: 1, replies: isNewReply ? 1 : 0 };
    state.entries.push({
      ts: effectiveTs,
      input: inp,
      cache,
      output: out,
      isNewReply,
    });
  }
}

function readIncrementalTranscript(state, st, nowMs) {
  let fd = -1;
  try {
    fd = openSync(state.filePath, 'r');

    let canAppend = state.offset > 0 && st.size >= state.offset;
    if (canAppend && state.headSig.length > 0) {
      const checkBuf = Buffer.alloc(state.headSig.length);
      const nHead = readSync(fd, checkBuf, 0, checkBuf.length, 0);
      if (nHead !== state.headSig.length || !checkBuf.equals(state.headSig)) {
        canAppend = false;
      }
    }

    if (!canAppend) {
      const fresh = createConversationState(state.convId, state.filePath);
      Object.assign(state, fresh);
    }

    const bytesToRead = st.size - state.offset;
    if (bytesToRead > 0) {
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, chunk, 0, bytesToRead, state.offset);
      if (state.offset === 0 && bytesRead > 0) {
        state.headSig = Buffer.from(chunk.subarray(0, Math.min(HEAD_SIG_BYTES, bytesRead)));
      }

      const slice = chunk.subarray(0, bytesRead);
      const lastNewline = slice.lastIndexOf(0x0a);
      let consumableBytes = lastNewline !== -1 ? lastNewline + 1 : 0;

      if (consumableBytes > 0) {
        const text = slice.toString('utf-8', 0, consumableBytes);
        for (const rawLine of text.split('\n')) {
          if (rawLine) {
            applyTranscriptLine(state, rawLine, st.mtimeMs);
          }
        }
        state.offset += consumableBytes;
      }

      if (consumableBytes < bytesRead) {
        const tailText = slice.toString('utf-8', consumableBytes, bytesRead).trim();
        let tailComplete = false;
        if (tailText.startsWith('{') && tailText.endsWith('}')) {
          try {
            JSON.parse(tailText);
            tailComplete = true;
          } catch {}
        }
        if (tailComplete) {
          applyTranscriptLine(state, tailText, st.mtimeMs);
          state.offset += bytesRead - consumableBytes;
          consumableBytes = bytesRead;
        } else if (nowMs - st.mtimeMs > 5000) {
          state.offset += bytesRead - consumableBytes;
          consumableBytes = bytesRead;
        }
      }
    }

    const fullyConsumed = state.offset >= st.size;
    state.mtimeMs = fullyConsumed ? st.mtimeMs : 0;
    state.size = state.offset;
    if (!state.lastActiveMs) {
      state.lastActiveMs = st.mtimeMs;
    }

    const cutoff = nowMs - RETENTION_MS;
    if (state.entries.length > 0 && state.entries[0].ts < cutoff) {
      let firstKeep = 0;
      while (firstKeep < state.entries.length && state.entries[firstKeep].ts < cutoff) {
        firstKeep++;
      }
      if (firstKeep > 0) {
        state.entries = state.entries.slice(firstKeep);
      }
    }

    state.contextBreakdown = buildContextBreakdown(state);
  } catch {
    // Keep prior valid state if file is momentarily locked mid-rename on Windows
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export class UsageTracker {
  #cache = new Map();
  #appDataDirs = null;
  #env;
  #home;
  #version;
  #assetVersion;
  #rev = 0;
  #lastRollup = null;
  #lastRollupExpiryMs = 0;

  constructor({ env = process.env, home = homedir(), appDataDirs = null, version = '0.8.0', assetVersion = '1' } = {}) {
    this.#env = env;
    this.#home = home;
    this.#appDataDirs = Array.isArray(appDataDirs) ? [...appDataDirs] : null;
    this.#version = version;
    this.#assetVersion = assetVersion;
  }

  #getAppDataDirs() {
    if (this.#appDataDirs && this.#appDataDirs.length > 0) {
      return this.#appDataDirs;
    }
    const dirs = discoverAppDataDirs(this.#env, this.#home);
    if (dirs.length > 0) {
      this.#appDataDirs = dirs;
    }
    return dirs;
  }

  #syncDisk(nowMs) {
    const appDataDirs = this.#getAppDataDirs();
    const seenKeys = new Set();
    let diskChanged = false;
    const allConvs = [];

    for (const appData of appDataDirs) {
      const brainDir = join(appData, 'brain');
      const convIds = safeReaddir(brainDir);
      for (const convId of convIds) {
        const logsDir = join(brainDir, convId, '.system_generated', 'logs');
        let filePath = join(logsDir, 'transcript.jsonl');
        let st = safeStat(filePath);
        if (!st) {
          filePath = join(logsDir, 'transcript_full.jsonl');
          st = safeStat(filePath);
        }
        if (!st) continue;

        seenKeys.add(logsDir);
        let state = this.#cache.get(logsDir);
        if (!state || state.filePath !== filePath) {
          state = createConversationState(convId, filePath);
          this.#cache.set(logsDir, state);
          diskChanged = true;
        }
        if (state.mtimeMs !== st.mtimeMs || state.size !== st.size) {
          readIncrementalTranscript(state, st, nowMs);
          diskChanged = true;
        }
        allConvs.push(state);
      }
    }

    for (const key of this.#cache.keys()) {
      if (!seenKeys.has(key)) {
        this.#cache.delete(key);
        diskChanged = true;
      }
    }

    return { allConvs, diskChanged };
  }

  #computeGlobalRollup(allConvs, nowMs, diskChanged) {
    if (!diskChanged && this.#lastRollup && nowMs < this.#lastRollupExpiryMs) {
      return this.#lastRollup;
    }

    const oneDayAgo = nowMs - ONE_DAY_MS;
    const sevenDaysAgo = nowMs - SEVEN_DAYS_MS;
    const daily = emptyBucket();
    const thisWeek = emptyBucket();
    let weeklyChatCount = 0;
    let nextExpiryMs = nowMs + 60_000;

    for (const rec of allConvs) {
      if (rec.lastActiveMs < sevenDaysAgo && (rec.entries.length === 0 || rec.entries[rec.entries.length - 1].ts < sevenDaysAgo)) {
        continue;
      }
      let activeInWeek = false;
      for (const e of rec.entries) {
        if (e.ts >= sevenDaysAgo) {
          activeInWeek = true;
          addTokens(thisWeek, e.input, e.cache, e.output, e.isNewReply);
          const weekExp = e.ts + SEVEN_DAYS_MS;
          if (weekExp > nowMs && weekExp < nextExpiryMs) {
            nextExpiryMs = weekExp;
          }
          if (e.ts >= oneDayAgo) {
            addTokens(daily, e.input, e.cache, e.output, e.isNewReply);
            const dayExp = e.ts + ONE_DAY_MS;
            if (dayExp > nowMs && dayExp < nextExpiryMs) {
              nextExpiryMs = dayExp;
            }
          }
        }
      }
      if (activeInWeek) {
        weeklyChatCount += 1;
      }
    }

    const prev = this.#lastRollup;
    const rollupChanged =
      diskChanged ||
      !prev ||
      prev.daily.total !== daily.total ||
      prev.daily.replies !== daily.replies ||
      prev.thisWeek.total !== thisWeek.total ||
      prev.thisWeek.replies !== thisWeek.replies ||
      prev.weeklyChatCount !== weeklyChatCount ||
      prev.conversationCount !== allConvs.length;

    if (rollupChanged) {
      this.#rev += 1;
    }

    this.#lastRollup = {
      daily,
      thisWeek,
      weeklyChatCount,
      conversationCount: allConvs.length,
    };
    this.#lastRollupExpiryMs = nextExpiryMs;
    return this.#lastRollup;
  }

  getSummary({ conversationId = '', sinceRev = 0, sinceConvId = '', now = Date.now() } = {}) {
    const requestedConvId = String(conversationId || '').trim();
    const { allConvs, diskChanged } = this.#syncDisk(now);
    const rollup = this.#computeGlobalRollup(allConvs, now, diskChanged);

    let activeRec = null;
    if (requestedConvId) {
      activeRec = allConvs.find((c) => c.convId === requestedConvId) || null;
    } else if (allConvs.length > 0) {
      const userConvs = allConvs.filter((c) => !c.isSubagent);
      const pool = userConvs.length > 0 ? userConvs : allConvs;
      let best = pool[0];
      for (let i = 1; i < pool.length; i++) {
        if (pool[i].lastActiveMs > best.lastActiveMs) {
          best = pool[i];
        }
      }
      activeRec = best;
    }

    const resolvedConvId = activeRec ? activeRec.convId : requestedConvId || '';
    if (sinceRev > 0 && sinceRev === this.#rev && sinceConvId === resolvedConvId) {
      return {
        ok: true,
        unchanged: true,
        rev: this.#rev,
        assetVersion: this.#assetVersion,
        conversationId: resolvedConvId || null,
      };
    }

    let activeModel = activeRec?.activeModel || '';
    if (!activeModel && allConvs.length > 0) {
      const userWithModel = allConvs.filter((c) => !c.isSubagent && c.activeModel);
      if (userWithModel.length > 0) {
        let latest = userWithModel[0];
        for (let i = 1; i < userWithModel.length; i++) {
          if (userWithModel[i].lastActiveMs > latest.lastActiveMs) {
            latest = userWithModel[i];
          }
        }
        activeModel = latest.activeModel;
      }
    }
    const contextLimit = inferContextLimit(activeModel);

    const oneDayAgo = now - ONE_DAY_MS;
    const sevenDaysAgo = now - SEVEN_DAYS_MS;
    const activeChatDaily = emptyBucket();
    const activeChatWeek = emptyBucket();
    if (activeRec) {
      for (const e of activeRec.entries) {
        if (e.ts >= sevenDaysAgo) {
          addTokens(activeChatWeek, e.input, e.cache, e.output, e.isNewReply);
          if (e.ts >= oneDayAgo) {
            addTokens(activeChatDaily, e.input, e.cache, e.output, e.isNewReply);
          }
        }
      }
    }

    return {
      ok: true,
      rev: this.#rev,
      version: this.#version,
      assetVersion: this.#assetVersion,
      conversationId: resolvedConvId || null,
      conversationCount: rollup.conversationCount,
      weeklyChatCount: rollup.weeklyChatCount,
      currentChat: activeRec
        ? {
            convId: activeRec.convId,
            isSubagent: activeRec.isSubagent,
            totals: activeRec.chatTotals,
            dailyTotals: activeChatDaily,
            weeklyTotals: activeChatWeek,
            lastTurn: activeRec.currentTurn.total > 0 ? activeRec.currentTurn : activeRec.lastNonEmptyTurn,
            lastStep: activeRec.lastStep,
            activeModel,
            contextLimit,
            compactedFrom: activeRec.compactedFrom,
            checkpointCount: activeRec.checkpointCount,
            contextBreakdown: activeRec.contextBreakdown,
            lastActiveMs: activeRec.lastActiveMs,
          }
        : {
            convId: requestedConvId || null,
            isSubagent: false,
            totals: emptyBucket(),
            dailyTotals: emptyBucket(),
            weeklyTotals: emptyBucket(),
            lastTurn: emptyBucket(),
            lastStep: emptyBucket(),
            activeModel,
            contextLimit,
            compactedFrom: 0,
            checkpointCount: 0,
            contextBreakdown: emptyBreakdown(),
            lastActiveMs: 0,
          },
      daily: rollup.daily,
      thisWeek: rollup.thisWeek,
      updatedAt: new Date(now).toISOString(),
    };
  }
}
