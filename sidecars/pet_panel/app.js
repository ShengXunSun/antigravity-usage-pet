(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  async function getJson(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
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

  function fmtBreakdown(b) {
    if (!b) return 'In 0 · Cache 0 · Out 0';
    return `In ${fmtTokens(b.input)} · Cache ${fmtTokens(b.cache)} · Out ${fmtTokens(b.output)}`;
  }

  const stage = $('pet-stage');
  const avatar = $('pet-avatar');
  const speechLine = $('speech-line');
  const dashboard = $('dashboard');
  const pinBtn = $('pin-btn');
  const reset5hBtn = $('reset-5h-btn');

  let isPinned = true;
  let lastSeenChatTotal = null;
  let latestData = null;
  let lineIdx = 0;
  let quotasInitialized = false;

  const QUOTA_KEYS = ['geminiWeekly', 'claudeWeekly', 'claude5h', 'gptWeekly', 'gpt5h'];
  const currentQuotas = {
    geminiWeekly: 100,
    claudeWeekly: 100,
    claude5h: 100,
    gptWeekly: 100,
    gpt5h: 100,
  };

  // Load cached quotas from localStorage immediately so there is zero flicker
  try {
    const saved = JSON.parse(localStorage.getItem('gemini_pet_quotas') || 'null');
    if (saved && typeof saved === 'object') {
      for (const k of QUOTA_KEYS) {
        if (saved[k] !== undefined) currentQuotas[k] = Number(saved[k]);
      }
      quotasInitialized = true;
    }
  } catch {
    // Ignore localStorage errors
  }

  function renderQuotaUI(key, val) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(val) || 0)));
    currentQuotas[key] = pct;
    const slider = $(`slider-${key}`);
    const label = $(`pct-${key}`);
    if (slider) {
      slider.value = String(pct);
      slider.style.setProperty('--pct', `${pct}%`);
    }
    if (label) {
      label.textContent = `${pct}%`;
    }
  }

  function renderAllQuotas() {
    for (const k of QUOTA_KEYS) {
      renderQuotaUI(k, currentQuotas[k]);
    }
  }

  async function persistQuotas() {
    try {
      localStorage.setItem('gemini_pet_quotas', JSON.stringify(currentQuotas));
    } catch {
      // Ignore
    }
    try {
      const qs = new URLSearchParams();
      for (const k of QUOTA_KEYS) qs.set(k, String(currentQuotas[k]));
      await getJson(`/api/save-quotas?${qs.toString()}`);
    } catch {
      // Ignore network/offline save errors
    }
  }

  for (const k of QUOTA_KEYS) {
    const slider = $(`slider-${k}`);
    if (!slider) continue;
    slider.addEventListener('input', (e) => {
      renderQuotaUI(k, e.target.value);
    });
    slider.addEventListener('change', () => {
      persistQuotas();
      triggerBounce();
      speechLine.textContent = `Updated quota sliders! ✨`;
    });
  }

  reset5hBtn.addEventListener('click', () => {
    renderQuotaUI('claude5h', 100);
    renderQuotaUI('gpt5h', 100);
    persistQuotas();
    triggerBounce();
    speechLine.textContent = `5h limits reset to 100%! 🌟`;
  });

  pinBtn.addEventListener('click', () => {
    isPinned = !isPinned;
    pinBtn.classList.toggle('active', isPinned);
    pinBtn.textContent = isPinned ? '📌 Pinned' : '📌 Unpinned';
    if (isPinned) {
      dashboard.classList.remove('collapsed');
    }
  });

  renderAllQuotas();

  function triggerBounce() {
    avatar.classList.remove('bounce');
    void avatar.offsetWidth;
    avatar.classList.add('bounce');
  }

  stage.addEventListener('click', () => {
    triggerBounce();
    if (!isPinned) {
      dashboard.classList.toggle('collapsed');
    }
    if (!latestData) return;
    const replyTok = fmtTokens(latestData.currentChat?.lastTurn?.total || 0);
    const chatTok = fmtTokens(latestData.currentChat?.totals?.total || 0);
    const weekTok = fmtTokens(latestData.thisWeek?.total || 0);
    const lines = [
      `This week: ${weekTok} tokens · Gem ${currentQuotas.geminiWeekly}% left ✨`,
      `Claude: ${currentQuotas.claudeWeekly}% wk / ${currentQuotas.claude5h}% 5h · GPT: ${currentQuotas.gptWeekly}% wk 💙`,
      `Last reply used ${replyTok} tokens (Chat: ${chatTok}) 🌟`,
      isPinned ? `Unpin 📌 at the top if you want click-to-hide! 🐾` : `Click me anytime to toggle the panel! 🐾`,
    ];
    lineIdx = (lineIdx + 1) % lines.length;
    speechLine.textContent = lines[lineIdx];
  });

  async function poll() {
    try {
      const conv = currentConv();
      const q = conv ? `?conversationId=${encodeURIComponent(conv)}` : '';
      const data = await getJson(`/api/usage${q}`);
      latestData = data;

      $('status-badge').textContent = data.ok ? 'Live' : 'Error';
      const cid = data.currentChat?.convId || data.conversationId;
      $('val-conv').textContent = cid ? cid.slice(0, 8) : 'auto';

      const lastTurn = data.currentChat?.lastTurn || { input: 0, cache: 0, output: 0, total: 0 };
      const chatTotals = data.currentChat?.totals || { input: 0, cache: 0, output: 0, total: 0 };

      $('val-last-reply').textContent = fmtTokens(lastTurn.total);
      $('val-chat-total').textContent = fmtTokens(chatTotals.total);

      $('val-5h').textContent = fmtTokens(data.last5h?.total || 0);
      $('sub-5h').textContent = fmtBreakdown(data.last5h);

      $('val-week').textContent = fmtTokens(data.thisWeek?.total || 0);
      $('sub-week').textContent = fmtBreakdown(data.thisWeek);

      if (!quotasInitialized && data.quotas) {
        for (const k of QUOTA_KEYS) {
          if (data.quotas[k] !== undefined) currentQuotas[k] = Number(data.quotas[k]);
        }
        renderAllQuotas();
        quotasInitialized = true;
      }

      if (lastSeenChatTotal !== null && chatTotals.total > lastSeenChatTotal) {
        triggerBounce();
        speechLine.textContent = `New reply! +${fmtTokens(lastTurn.total)} tokens ✨`;
      }
      lastSeenChatTotal = chatTotals.total;
    } catch (err) {
      $('status-badge').textContent = 'Offline';
    }
  }

  poll();
  setInterval(poll, 1500);
})();
