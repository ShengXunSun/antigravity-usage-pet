(() => {
  const params = new URLSearchParams(location.search);
  const sidecarToken = params.get('token') || '';
  const initialConvId = params.get('conversationId') || '';
  const scriptEl = document.querySelector('script[data-asset-ver]');
  const initialAssetVer = scriptEl?.dataset?.assetVer || '';

  // Forward IDE modifier chords to parent host without loading preload.js (which spawns agentapi on load)
  if (window.parent && window.parent !== window) {
    const pureMods = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph']);
    const forwarded = new Set();
    const keyId = (e) => e.code || (typeof e.key === 'string' ? e.key.toLowerCase() : '');
    const postKey = (e) => {
      window.parent.postMessage(
        {
          type: 'sidecar-key-event',
          payload: {
            eventType: e.type,
            key: e.key,
            code: e.code || '',
            ctrlKey: Boolean(e.ctrlKey),
            metaKey: Boolean(e.metaKey),
            altKey: Boolean(e.altKey),
            shiftKey: Boolean(e.shiftKey),
            repeat: Boolean(e.repeat),
          },
        },
        '*'
      );
    };
    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (typeof e.key !== 'string' || pureMods.has(e.key)) return;
      if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
      if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return;
      const kl = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && ((!e.shiftKey && (kl === 'c' || kl === 'x')) || kl === 'v')) return;
      const id = keyId(e);
      if (id) forwarded.add(id);
      postKey(e);
    });
    window.addEventListener('keyup', (e) => {
      if (e.isComposing || e.keyCode === 229 || typeof e.key !== 'string') return;
      const id = keyId(e);
      const had = id && forwarded.delete(id);
      if (had || (forwarded.size > 0 && e.key === 'Meta')) {
        if (e.key === 'Meta') forwarded.clear();
        postKey(e);
      }
    });
    window.addEventListener('blur', () => forwarded.clear());
  }

  const $ = (id) => document.getElementById(id);
  const el = {
    dashboard: $('dashboard'),
    valConv: $('val-conv'),
    reloadBtn: $('reload-btn'),
    pinBtn: $('pin-btn'),
    statusBadge: $('status-badge'),
    valWeek: $('val-week'),
    subWeek: $('sub-week'),
    valDaily: $('val-daily'),
    subDaily: $('sub-daily'),
    icoCard: $('ico-card'),
    icoTitle: $('ico-title'),
    cacheHitBadge: $('cache-hit-badge'),
    lblInType: $('lbl-in-type'),
    tokInWeek: $('tok-in-week'),
    barIn: $('bar-in'),
    subIn: $('sub-in'),
    lblCacheType: $('lbl-cache-type'),
    tokCacheWeek: $('tok-cache-week'),
    barCache: $('bar-cache'),
    subCache: $('sub-cache'),
    lblOutType: $('lbl-out-type'),
    tokOutWeek: $('tok-out-week'),
    barOut: $('bar-out'),
    subOut: $('sub-out'),
    ctxCard: $('ctx-card'),
    ctxCapBtn: $('ctx-cap-btn'),
    ctxStatusLabel: $('ctx-status-label'),
    valCtxWindow: $('val-ctx-window'),
    barCtx: $('bar-ctx'),
    subCtx: $('sub-ctx'),
    tipCtxTotal: $('tip-ctx-total'),
    segTools: $('seg-tools'),
    segMsgs: $('seg-msgs'),
    segSys: $('seg-sys'),
    segThink: $('seg-think'),
    tipTools: $('tip-tools'),
    tipMsgs: $('tip-msgs'),
    tipSys: $('tip-sys'),
    tipThink: $('tip-think'),
    stage: $('pet-stage'),
    avatar: $('pet-avatar'),
    petImg: $('pet-img'),
    valLastReply: $('val-last-reply'),
    valChatTotal: $('val-chat-total'),
    speechLine: $('speech-line'),
  };

  const UI_STATE_KEY = 'gemini_pet_ui_state';
  const CAP_STATE_KEY = 'gemini_pet_ctx_cap_v2';
  const CTX_CAPS = [200_000, 1_000_000];
  const POLL_MS = 1500;

  let isPinned = true;
  let isCollapsed = false;
  let isHoveringIco = false;
  let ctxCapIdx = 1;
  let savedCapState = null;
  let currentModelKey = null;
  let currentSpriteKey = null;
  let currentPetUrl = '';
  let loadedAssetVer = initialAssetVer && !initialAssetVer.startsWith('__') ? initialAssetVer : null;
  let lastSeenChatTotal = null;
  let latestData = null;
  let lineIdx = -1;
  let lastRev = 0;
  let lastReqConv = '';
  let pollInFlight = false;
  let pollTimer = null;

  function readStorageJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeStorageJson(key, val) {
    try {
      if (val === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  }

  const storedUi = readStorageJson(UI_STATE_KEY);
  if (storedUi && typeof storedUi.pinned === 'boolean') {
    isPinned = storedUi.pinned;
    isCollapsed = !isPinned && Boolean(storedUi.collapsed);
  }
  const storedCap = readStorageJson(CAP_STATE_KEY);
  if (storedCap && (storedCap.cap === 200_000 || storedCap.cap === 1_000_000) && typeof storedCap.modelKey === 'string') {
    savedCapState = storedCap;
    ctxCapIdx = storedCap.cap === 1_000_000 ? 1 : 0;
  }

  function syncPinUi() {
    if (el.pinBtn) {
      el.pinBtn.classList.toggle('active', isPinned);
      el.pinBtn.textContent = isPinned ? '📌 Pinned' : '📌 Unpinned';
    }
    if (el.dashboard) {
      el.dashboard.classList.toggle('collapsed', !isPinned && isCollapsed);
    }
  }
  syncPinUi();

  let audioCtx = null;
  let nyaaBuffer = null;
  let nyaaBytesPromise = null;
  let activeSource = null;
  let playGen = 0;

  function loadNyaaBytes() {
    if (!nyaaBytesPromise) {
      const q = loadedAssetVer ? `?v=${encodeURIComponent(loadedAssetVer)}` : '';
      const headers = sidecarToken ? { 'X-Sidecar-Token': sidecarToken } : {};
      nyaaBytesPromise = fetch(`/nyaa.wav${q}`, { method: 'GET', headers })
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
    }
    return nyaaBytesPromise;
  }

  async function playNyaa() {
    const myGen = ++playGen;
    if (activeSource) {
      try {
        activeSource.onended = null;
        activeSource.stop(0);
        activeSource.disconnect();
      } catch {}
      activeSource = null;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) {
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    if (!nyaaBuffer) {
      const bytes = await loadNyaaBytes();
      if (!bytes || myGen !== playGen) return;
      try {
        nyaaBuffer = await audioCtx.decodeAudioData(bytes.slice(0));
      } catch {
        return;
      }
      if (myGen !== playGen) return;
    }

    const src = audioCtx.createBufferSource();
    src.buffer = nyaaBuffer;
    src.connect(audioCtx.destination);
    activeSource = src;
    src.onended = () => {
      if (activeSource === src) activeSource = null;
    };
    src.start(0);
  }

  async function postJson(path, payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (sidecarToken) {
      headers['X-Sidecar-Token'] = sidecarToken;
    }
    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function fmtTokens(n) {
    const num = Number(n) || 0;
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
    if (num >= 10_000) return (num / 1_000).toFixed(1) + 'k';
    if (num >= 1_000) return (num / 1_000).toFixed(2) + 'k';
    return String(num);
  }

  function classifyModelKey(modelName) {
    const m = String(modelName || '').toLowerCase();
    if (m.includes('claude')) return 'claude';
    if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'other';
    return 'gemini';
  }

  function triggerBounce() {
    if (!el.avatar) return;
    el.avatar.classList.remove('bounce');
    void el.avatar.offsetWidth;
    el.avatar.classList.add('bounce');
  }

  function updatePetAndModelState(currentChat, assetVersion) {
    if (assetVersion) {
      if (loadedAssetVer !== null && loadedAssetVer !== assetVersion) {
        location.reload();
        return true;
      }
      loadedAssetVer = assetVersion;
    }

    const nextModelKey = classifyModelKey(currentChat?.activeModel);
    const nextSpriteKey = nextModelKey === 'claude' ? 'claude' : 'gemini';
    const ver = loadedAssetVer || '1';
    const nextUrl = nextSpriteKey === 'claude' ? `/pet-claude.png?v=${ver}` : `/pet.png?v=${ver}`;

    const isFirstRender = currentModelKey === null;
    const modelChanged = !isFirstRender && nextModelKey !== currentModelKey;
    const spriteChanged = !isFirstRender && nextSpriteKey !== currentSpriteKey;

    currentModelKey = nextModelKey;
    currentSpriteKey = nextSpriteKey;

    if (nextUrl !== currentPetUrl) {
      currentPetUrl = nextUrl;
      if (el.petImg) {
        el.petImg.src = nextUrl;
      }
    }

    if (modelChanged) {
      savedCapState = null;
      writeStorageJson(CAP_STATE_KEY, null);
      ctxCapIdx = (currentChat?.contextLimit || 1_000_000) >= 1_000_000 ? 1 : 0;
      if (spriteChanged) {
        triggerBounce();
      }
    } else if (savedCapState && savedCapState.modelKey === nextModelKey) {
      ctxCapIdx = savedCapState.cap === 1_000_000 ? 1 : 0;
    } else {
      ctxCapIdx = (currentChat?.contextLimit || 1_000_000) >= 1_000_000 ? 1 : 0;
    }
    return false;
  }

  function renderContextWindow(currentChat) {
    const lastStep = currentChat?.lastStep || { input: 0, cache: 0, output: 0, total: 0 };
    const cap = CTX_CAPS[ctxCapIdx];
    const capLabel = cap >= 1_000_000 ? '1M' : '200k';
    if (el.ctxCapBtn) {
      el.ctxCapBtn.textContent = `Cap: ${capLabel} ⇄`;
    }

    const used = Number(lastStep.total) || 0;
    const rawPct = Math.round((used / cap) * 100);
    const barPct = Math.min(100, Math.max(used > 0 ? 2 : 0, rawPct));

    el.ctxStatusLabel.textContent = 'Active Context Size';
    el.valCtxWindow.textContent = `${fmtTokens(used)} / ${capLabel} (${rawPct}%)`;
    el.barCtx.style.width = `${barPct}%`;

    const compactedNote = currentChat?.compactedFrom ? ` · Auto-compacted @ ${fmtTokens(currentChat.compactedFrom)}` : '';
    const compactHint = rawPct >= 80 ? ' · 💡 Try /compact' : '';
    el.subCtx.textContent = `Cached: ${fmtTokens(lastStep.cache)} · New In: ${fmtTokens(lastStep.input)} · Out: ${fmtTokens(lastStep.output)}${compactedNote}${compactHint}`;

    const bd = currentChat?.contextBreakdown || {
      toolsTokens: 0,
      messagesTokens: 0,
      systemTokens: 0,
      thinkingTokens: 0,
      toolsPct: 0,
      messagesPct: 0,
      systemPct: 0,
      thinkingPct: 0,
    };
    el.tipCtxTotal.textContent = `${fmtTokens(used)} tokens`;
    el.segTools.style.width = `${bd.toolsPct}%`;
    el.segMsgs.style.width = `${bd.messagesPct}%`;
    el.segSys.style.width = `${bd.systemPct}%`;
    el.segThink.style.width = `${bd.thinkingPct}%`;

    el.tipTools.textContent = `${bd.toolsPct}% (${fmtTokens(bd.toolsTokens)})`;
    el.tipMsgs.textContent = `${bd.messagesPct}% (${fmtTokens(bd.messagesTokens)})`;
    el.tipSys.textContent = `${bd.systemPct}% (${fmtTokens(bd.systemTokens)})`;
    el.tipThink.textContent = `${bd.thinkingPct}% (${fmtTokens(bd.thinkingTokens)})`;
  }

  function renderIcoCard(data) {
    if (!data) return;
    const empty = { input: 0, cache: 0, output: 0, total: 0 };
    const lastTurn = data.currentChat?.lastTurn || empty;
    const chatTotals = data.currentChat?.totals || empty;
    const chatDaily = data.currentChat?.dailyTotals || empty;
    const chatWeek = data.currentChat?.weeklyTotals || empty;
    const daily = data.daily || empty;
    const week = data.thisWeek || empty;

    const showChatAllTimeFallback = isHoveringIco && chatWeek.total === 0 && chatTotals.total > 0;
    const activeBucket = isHoveringIco ? (showChatAllTimeFallback ? chatTotals : chatWeek) : week;
    const totalActive = Math.max(1, activeBucket.total);

    const inSharePct = Math.min(100, Math.round((activeBucket.input / totalActive) * 100));
    const cacheSharePct = Math.min(100, Math.round((activeBucket.cache / totalActive) * 100));
    const outSharePct = Math.round((activeBucket.output / totalActive) * 100);
    const outBarPct = Math.min(100, Math.max(activeBucket.output > 0 ? 2 : 0, outSharePct));

    const promptTotal = activeBucket.input + activeBucket.cache;
    const cacheHitPct = promptTotal > 0 ? Math.round((activeBucket.cache / promptTotal) * 100) : 0;

    if (el.icoTitle) {
      el.icoTitle.textContent = !isHoveringIco
        ? 'Weekly Input · Cache · Output Tokens'
        : showChatAllTimeFallback
          ? 'This Chat (All-Time) · Input · Cache · Output'
          : 'This Chat (7d) · Input · Cache · Output';
    }
    el.lblInType.textContent = isHoveringIco ? 'Input (This Chat)' : 'Input Tokens';
    el.lblCacheType.textContent = isHoveringIco ? 'Cache (This Chat)' : 'Cache Tokens';
    el.lblOutType.textContent = isHoveringIco ? 'Output (This Chat)' : 'Output Tokens';
    el.cacheHitBadge.textContent = `Cache Hit: ${cacheHitPct}%`;

    const dailySub = isHoveringIco ? chatDaily : daily;
    const dailyPrefix = isHoveringIco ? 'Chat 24h' : 'Daily';

    el.tokInWeek.textContent = `${fmtTokens(activeBucket.input)} (${inSharePct}%)`;
    el.barIn.style.width = `${inSharePct}%`;
    el.subIn.textContent = `${dailyPrefix}: ${fmtTokens(dailySub.input)} · Chat: ${fmtTokens(chatTotals.input)} · Reply: ${fmtTokens(lastTurn.input)}`;

    el.tokCacheWeek.textContent = `${fmtTokens(activeBucket.cache)} (${cacheSharePct}%)`;
    el.barCache.style.width = `${cacheSharePct}%`;
    el.subCache.textContent = `${dailyPrefix}: ${fmtTokens(dailySub.cache)} · Chat: ${fmtTokens(chatTotals.cache)} · Reply: ${fmtTokens(lastTurn.cache)}`;

    el.tokOutWeek.textContent = `${fmtTokens(activeBucket.output)} (${outSharePct}%)`;
    el.barOut.style.width = `${outBarPct}%`;
    el.subOut.textContent = `${dailyPrefix}: ${fmtTokens(dailySub.output)} · Chat: ${fmtTokens(chatTotals.output)} · Reply: ${fmtTokens(lastTurn.output)}`;
  }

  if (el.reloadBtn) {
    el.reloadBtn.addEventListener('click', () => location.reload());
  }

  if (el.icoCard) {
    el.icoCard.addEventListener('mouseenter', () => {
      isHoveringIco = true;
      if (latestData) renderIcoCard(latestData);
    });
    el.icoCard.addEventListener('mouseleave', () => {
      isHoveringIco = false;
      if (latestData) renderIcoCard(latestData);
    });
  }

  if (el.ctxCapBtn) {
    el.ctxCapBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      ctxCapIdx = (ctxCapIdx + 1) % CTX_CAPS.length;
      const chosenCap = CTX_CAPS[ctxCapIdx];
      savedCapState = { cap: chosenCap, modelKey: currentModelKey || 'gemini' };
      writeStorageJson(CAP_STATE_KEY, savedCapState);
      if (latestData) renderContextWindow(latestData.currentChat);
    });
  }

  if (el.ctxCard) {
    el.ctxCard.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      el.ctxCard.classList.toggle('tooltip-pinned');
    });
    el.ctxCard.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        el.ctxCard.classList.remove('tooltip-pinned');
        el.ctxCard.blur();
      } else if ((e.key === 'Enter' || e.key === ' ') && e.target === el.ctxCard) {
        e.preventDefault();
        el.ctxCard.classList.toggle('tooltip-pinned');
      }
    });
  }

  if (el.pinBtn) {
    el.pinBtn.addEventListener('click', () => {
      isPinned = !isPinned;
      if (isPinned) isCollapsed = false;
      syncPinUi();
      writeStorageJson(UI_STATE_KEY, { pinned: isPinned, collapsed: isCollapsed });
    });
  }

  if (el.stage) {
    el.stage.addEventListener('click', () => {
      playNyaa();
      triggerBounce();
      if (!isPinned) {
        isCollapsed = !isCollapsed;
        syncPinUi();
        writeStorageJson(UI_STATE_KEY, { pinned: isPinned, collapsed: isCollapsed });
      }
      if (!latestData) return;
      const empty = { input: 0, cache: 0, output: 0, total: 0 };
      const lastTurn = latestData.currentChat?.lastTurn || empty;
      const lastStep = latestData.currentChat?.lastStep || empty;
      const week = latestData.thisWeek || empty;

      const lines = [
        `Nyaa~ Context window is at ${fmtTokens(lastStep.total)} tokens! ✨`,
        `Nyaa~ Last reply: In ${fmtTokens(lastTurn.input)} · Cache ${fmtTokens(lastTurn.cache)} · Out ${fmtTokens(lastTurn.output)} 💙`,
        `Nyaa~ This week: ${fmtTokens(week.total)} total (${fmtTokens(week.cache)} cached!) 🌟`,
        isPinned ? `Unpin 📌 at the top if you want click-to-hide! 🐾` : `Click me anytime to toggle the panel! 🐾`,
      ];
      lineIdx = (lineIdx + 1) % lines.length;
      el.speechLine.textContent = lines[lineIdx];
    });
  }

  async function pollOnce() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const data = await postJson('/api/usage', {
        conversationId: initialConvId,
        sinceRev: lastRev,
        sinceConvId: lastReqConv,
      });

      if (data.assetVersion && loadedAssetVer && data.assetVersion !== loadedAssetVer) {
        location.reload();
        return;
      }

      if (data.unchanged && latestData) {
        el.statusBadge.textContent = 'Live';
        return;
      }

      latestData = data;
      lastRev = Number(data.rev) || 0;
      lastReqConv = data.conversationId || initialConvId || '';

      el.statusBadge.textContent = data.ok ? 'Live' : 'Error';
      const cid = data.currentChat?.convId || data.conversationId;
      el.valConv.textContent = cid ? cid.slice(0, 8) : 'auto';

      const empty = { input: 0, cache: 0, output: 0, total: 0, steps: 0, replies: 0 };
      const lastTurn = data.currentChat?.lastTurn || empty;
      const chatTotals = data.currentChat?.totals || empty;
      const daily = data.daily || empty;
      const week = data.thisWeek || empty;

      el.valLastReply.textContent = fmtTokens(lastTurn.total);
      el.valChatTotal.textContent = fmtTokens(chatTotals.total);

      el.valWeek.textContent = fmtTokens(week.total);
      const weekChats = data.weeklyChatCount ?? data.conversationCount ?? 0;
      el.subWeek.textContent = `${week.replies ?? week.steps ?? 0} replies across ${weekChats} ${weekChats === 1 ? 'chat' : 'chats'}`;

      el.valDaily.textContent = fmtTokens(daily.total);
      el.subDaily.textContent = `${daily.replies ?? daily.steps ?? 0} ${daily.replies === 1 ? 'reply' : 'replies'} today`;

      if (updatePetAndModelState(data.currentChat, data.assetVersion)) {
        return;
      }

      renderIcoCard(data);
      renderContextWindow(data.currentChat);

      if (lastSeenChatTotal !== null && chatTotals.total > lastSeenChatTotal) {
        triggerBounce();
        el.speechLine.textContent = `Reply: In ${fmtTokens(lastTurn.input)} · Cache ${fmtTokens(lastTurn.cache)} · Out ${fmtTokens(lastTurn.output)} ✨`;
      }
      lastSeenChatTotal = chatTotals.total;
    } catch {
      el.statusBadge.textContent = 'Offline';
    } finally {
      pollInFlight = false;
    }
  }

  function scheduleNextPoll() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (document.hidden) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      await pollOnce();
      scheduleNextPoll();
    }, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    } else {
      pollOnce().then(scheduleNextPoll);
    }
  });

  pollOnce().then(() => {
    loadNyaaBytes();
    scheduleNextPoll();
  });
})();
