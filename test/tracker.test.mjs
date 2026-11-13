import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  UsageTracker,
  apportionPercentages,
  discoverAppDataDirs,
  extractLastModelChange,
  inferContextLimit,
} from '../sidecars/pet_panel/tracker.mjs';

function makeTempEnv() {
  const root = mkdtempSync(join(tmpdir(), 'whale-pet-test-'));
  const appData = join(root, '.gemini', 'antigravity');
  mkdirSync(join(appData, 'brain'), { recursive: true });
  return {
    root,
    appData,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeTranscript(appData, convId, lines, mtimeMs = Date.now()) {
  const logsDir = join(appData, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const fp = join(logsDir, 'transcript.jsonl');
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  writeFileSync(fp, body, 'utf-8');
  const d = new Date(mtimeMs);
  utimesSync(fp, d, d);
  return fp;
}

test('apportionPercentages always sums to 100 and keeps zero-token categories at 0%', () => {
  assert.deepEqual(apportionPercentages([0, 0, 0, 0]), [0, 0, 0, 0]);
  assert.deepEqual(apportionPercentages([335, 335, 330, 0]), [34, 33, 33, 0]);
  assert.deepEqual(apportionPercentages([334, 334, 332, 0]), [34, 33, 33, 0]);

  for (let a = 0; a <= 7; a++) {
    for (let b = 0; b <= 7; b++) {
      for (let c = 0; c <= 7; c++) {
        for (let d = 0; d <= 7; d++) {
          const pcts = apportionPercentages([a, b, c, d]);
          const sum = pcts[0] + pcts[1] + pcts[2] + pcts[3];
          if (a + b + c + d === 0) {
            assert.equal(sum, 0);
          } else {
            assert.equal(sum, 100, `expected 100 for [${a},${b},${c},${d}], got ${pcts}`);
            if (a === 0) assert.equal(pcts[0], 0);
            if (b === 0) assert.equal(pcts[1], 0);
            if (c === 0) assert.equal(pcts[2], 0);
            if (d === 0) assert.equal(pcts[3], 0);
          }
        }
      }
    }
  }
});

test('extractLastModelChange ignores user text outside USER_SETTINGS_CHANGE and picks the last change', () => {
  const spoofedPrompt = [
    '<USER_REQUEST>',
    'Here is a log: The user changed setting `Model Selection` from X to FakeModel 1.0. No need to comment.',
    '</USER_REQUEST>',
    '<ADDITIONAL_METADATA>',
    '<USER_SETTINGS_CHANGE>',
    "The user changed setting `Model Selection` from None to Gemini 4 Carbon (High). No need to comment on this change if the user doesn't ask about it.",
    "The user changed setting `Model Selection` from Gemini 4 Carbon (High) to Claude Opus 5.5 (High). No need to comment on this change if the user doesn't ask about it.",
    '</USER_SETTINGS_CHANGE>',
    '</ADDITIONAL_METADATA>',
  ].join('\n');

  assert.equal(extractLastModelChange(spoofedPrompt), 'Claude Opus 5.5 (High)');
  assert.equal(
    extractLastModelChange('The user changed setting `Model Selection` from A to B. No need to comment'),
    ''
  );
});

test('inferContextLimit defaults empty and Gemini models to 1M and Claude/GPT to 200k', () => {
  assert.equal(inferContextLimit(''), 1_000_000);
  assert.equal(inferContextLimit('Gemini 4 Carbon (High)'), 1_000_000);
  assert.equal(inferContextLimit('Claude Sonnet 5.5 (High)'), 200_000);
  assert.equal(inferContextLimit('GPT-OSS 120B (Medium)'), 200_000);
  assert.equal(inferContextLimit('o3-mini'), 200_000);
});

test('discoverAppDataDirs falls back to home .gemini scan when ANTIGRAVITY_EXECUTABLE_DATA_DIR has no sidecar_data parent', () => {
  const tmp = makeTempEnv();
  try {
    const dirs = discoverAppDataDirs({ ANTIGRAVITY_EXECUTABLE_DATA_DIR: join(tmp.root, 'unrelated', 'dir') }, tmp.root);
    assert.deepEqual(dirs, [tmp.appData]);
  } finally {
    tmp.cleanup();
  }
});

test('CHECKPOINT drops active context size, uses content length for msgChars, and excludes compaction from Last Reply and replies count', () => {
  const tmp = makeTempEnv();
  try {
    const now = Date.parse('2026-11-13T03:00:00Z');
    const summaryBody = '<CONTEXT_SUMMARY>\n' + 'S'.repeat(4000) + '\n</CONTEXT_SUMMARY>';
    writeTranscript(tmp.appData, 'conv-compact', [
      {
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: '2026-11-13T01:00:00Z',
        content: '<USER_REQUEST>hello</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-11-13T01:00:05Z',
        input_tokens: 16000,
        cache_read_tokens: 0,
        output_tokens: 500,
        content: 'First reply',
      },
      {
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: '2026-11-13T02:00:00Z',
        content: '<USER_REQUEST>/compact</USER_REQUEST>',
      },
      {
        type: 'CHECKPOINT',
        source: 'SYSTEM',
        created_at: '2026-11-13T02:00:10Z',
        input_tokens: 237000,
        cache_read_tokens: 0,
        output_tokens: 12000,
        content: summaryBody,
      },
    ]);

    const tracker = new UsageTracker({ appDataDirs: [tmp.appData], version: '1.0.0' });
    const res = tracker.getSummary({ conversationId: 'conv-compact', now });

    assert.equal(res.currentChat.compactedFrom, 249000);
    assert.ok(res.currentChat.lastStep.total < 25000, `expected compacted context < 25k, got ${res.currentChat.lastStep.total}`);
    assert.equal(res.currentChat.lastTurn.total, 16500, 'Last Reply keeps actual chat reply instead of 249k compaction');
    assert.equal(res.daily.replies, 1, 'CHECKPOINT does not increment user-facing reply count');
    assert.equal(res.daily.steps, 2, 'CHECKPOINT still counts as a billed LLM step');
    assert.equal(res.daily.total, 16500 + 249000, 'CHECKPOINT tokens remain in billed totals');
  } finally {
    tmp.cleanup();
  }
});

test('multi-step tool loop counts as 1 reply with N steps, and SYSTEM_MESSAGE starts a new autonomous turn', () => {
  const tmp = makeTempEnv();
  try {
    const now = Date.parse('2026-11-13T03:00:00Z');
    writeTranscript(tmp.appData, 'conv-tools', [
      {
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: '2026-11-13T02:00:00Z',
        content: '<USER_REQUEST>audit repo</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-11-13T02:00:02Z',
        input_tokens: 15000,
        cache_read_tokens: 0,
        output_tokens: 300,
        tool_calls: [{ name: 'read_file', args: { Path: 'a.js' } }],
      },
      {
        type: 'GENERIC',
        source: 'MODEL',
        created_at: '2026-11-13T02:00:03Z',
        content: 'file contents '.repeat(200),
      },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-11-13T02:00:05Z',
        input_tokens: 1500,
        cache_read_tokens: 15000,
        output_tokens: 400,
        content: 'Done auditing',
      },
      {
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        created_at: '2026-11-13T02:10:00Z',
        content: '<SYSTEM_MESSAGE>Subagent completed</SYSTEM_MESSAGE>',
      },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-11-13T02:10:04Z',
        input_tokens: 2000,
        cache_read_tokens: 16500,
        output_tokens: 600,
        content: 'Subagent summary',
      },
    ]);

    const tracker = new UsageTracker({ appDataDirs: [tmp.appData] });
    const res = tracker.getSummary({ conversationId: 'conv-tools', now });

    assert.equal(res.daily.steps, 3);
    assert.equal(res.daily.replies, 2);
    assert.equal(res.currentChat.lastTurn.total, 19100, 'SYSTEM_MESSAGE wakeup isolated its own Last Reply');
  } finally {
    tmp.cleanup();
  }
});

test('new unsent conversationId returns empty chat instead of hijacking older chat, and subagents do not hijack auto-detect', () => {
  const tmp = makeTempEnv();
  try {
    const now = Date.parse('2026-11-13T03:00:00Z');
    const tenDaysAgoIso = new Date(now - 10 * 24 * 3600 * 1000).toISOString();

    writeTranscript(tmp.appData, 'old-chat', [
      {
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: tenDaysAgoIso,
        content: '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Claude Sonnet 5.5 (High). No need to comment.\n</USER_SETTINGS_CHANGE>',
      },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: tenDaysAgoIso,
        input_tokens: 20000,
        cache_read_tokens: 0,
        output_tokens: 500,
        content: 'Old reply',
      },
    ], now - 10 * 24 * 3600 * 1000);

    writeTranscript(tmp.appData, 'user-chat', [
      {
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: '2026-11-13T02:30:00Z',
        content: '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Claude Sonnet 5.5 (High) to Gemini 4 Carbon (High). No need to comment.\n</USER_SETTINGS_CHANGE>',
      },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-11-13T02:30:05Z',
        input_tokens: 18000,
        cache_read_tokens: 0,
        output_tokens: 400,
        content: 'User chat reply',
      },
    ]);

    writeTranscript(tmp.appData, 'subagent-chat', [
      {
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        created_at: '2026-11-13T02:59:00Z',
        content: 'The following is a <SYSTEM_MESSAGE> subagent task',
      },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-11-13T02:59:10Z',
        input_tokens: 12000,
        cache_read_tokens: 0,
        output_tokens: 300,
        content: 'Subagent output',
      },
    ]);

    const tracker = new UsageTracker({ appDataDirs: [tmp.appData] });

    const autoRes = tracker.getSummary({ conversationId: '', now });
    assert.equal(autoRes.currentChat.convId, 'user-chat', 'subagent did not hijack auto-detected user chat');
    assert.equal(autoRes.weeklyChatCount, 2, 'only 2 chats active in last 7 days, excluding 10-day-old chat');
    assert.equal(autoRes.conversationCount, 3);
    assert.equal(autoRes.thisWeek.total, 18400 + 12300, 'subagent tokens still count in weekly total');

    const brandNewRes = tracker.getSummary({ conversationId: 'brand-new-uuid', now });
    assert.equal(brandNewRes.currentChat.convId, 'brand-new-uuid');
    assert.equal(brandNewRes.currentChat.totals.total, 0, 'brand-new chat starts at 0 tokens');
    assert.equal(brandNewRes.currentChat.activeModel, 'Gemini 4 Carbon (High)');

    const oldChatRes = tracker.getSummary({ conversationId: 'old-chat', now });
    assert.equal(oldChatRes.currentChat.weeklyTotals.total, 0, '10-day-old chat reports 0 weekly tokens instead of all-time');
    assert.equal(oldChatRes.currentChat.totals.total, 20500);
  } finally {
    tmp.cleanup();
  }
});

test('incremental byte-offset reader handles appends, partial mid-write lines, newline-less JSON, deleted chats, and sinceRev short-circuit', () => {
  const tmp = makeTempEnv();
  try {
    const now = Date.parse('2026-11-13T03:00:00Z');
    const fp = writeTranscript(tmp.appData, 'inc-chat', [
      {
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: '2026-11-13T02:50:00Z',
        content: '<USER_REQUEST>step 1</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-11-13T02:50:05Z',
        input_tokens: 10000,
        cache_read_tokens: 0,
        output_tokens: 200,
        content: 'reply 1',
      },
    ], now - 1000);

    const tracker = new UsageTracker({ appDataDirs: [tmp.appData] });
    const r1 = tracker.getSummary({ conversationId: 'inc-chat', now });
    assert.equal(r1.currentChat.totals.total, 10200);

    const unchanged = tracker.getSummary({
      conversationId: 'inc-chat',
      sinceRev: r1.rev,
      sinceConvId: 'inc-chat',
      now: now + 500,
    });
    assert.equal(unchanged.unchanged, true);

    const halfLine = '{"type":"PLANNER_RESPONSE","source":"MODEL","input_tokens":5000,';
    appendFileSync(fp, halfLine, 'utf-8');
    utimesSync(fp, new Date(now), new Date(now));

    const rMidWrite = tracker.getSummary({ conversationId: 'inc-chat', now: now + 1000 });
    assert.equal(rMidWrite.currentChat.totals.total, 10200, 'incomplete JSON tail is buffered until write finishes');

    const restOfLineNoNewline = '"cache_read_tokens":10000,"output_tokens":300,"created_at":"2026-11-13T02:51:00Z"}';
    appendFileSync(fp, restOfLineNoNewline, 'utf-8');
    utimesSync(fp, new Date(now + 1500), new Date(now + 1500));

    const rCompleted = tracker.getSummary({ conversationId: 'inc-chat', now: now + 2000 });
    assert.equal(rCompleted.currentChat.totals.total, 10200 + 15300, 'completed JSON line parsed incrementally');
    assert.equal(rCompleted.currentChat.lastStep.total, 15300);

    rmSync(join(tmp.appData, 'brain', 'inc-chat'), { recursive: true, force: true });
    const rAfterDelete = tracker.getSummary({ conversationId: '', now: now + 3000 });
    assert.equal(rAfterDelete.conversationCount, 0, 'deleted conversation evicted from cache');
    assert.equal(rAfterDelete.thisWeek.total, 0);
  } finally {
    tmp.cleanup();
  }
});

test('missing created_at falls back to file mtimeMs and file replacement triggers clean re-parse', () => {
  const tmp = makeTempEnv();
  try {
    const now = Date.parse('2026-11-13T03:00:00Z');
    writeTranscript(
      tmp.appData,
      'no-ts-chat',
      [
        { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>hi</USER_REQUEST>' },
        { type: 'PLANNER_RESPONSE', source: 'MODEL', input_tokens: 4000, cache_read_tokens: 1000, output_tokens: 100 },
      ],
      now - 5000
    );

    const tracker = new UsageTracker({ appDataDirs: [tmp.appData] });
    const r1 = tracker.getSummary({ conversationId: 'no-ts-chat', now });
    assert.equal(r1.daily.total, 5100, 'entry without created_at uses file mtimeMs for daily window');

    writeTranscript(
      tmp.appData,
      'no-ts-chat',
      [
        { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>replaced</USER_REQUEST>' },
        { type: 'PLANNER_RESPONSE', source: 'MODEL', input_tokens: 2000, cache_read_tokens: 0, output_tokens: 50 },
      ],
      now - 1000
    );
    const r2 = tracker.getSummary({ conversationId: 'no-ts-chat', now });
    assert.equal(r2.currentChat.totals.total, 2050, 'file shrink/replacement triggers full re-parse from byte 0');
  } finally {
    tmp.cleanup();
  }
});
