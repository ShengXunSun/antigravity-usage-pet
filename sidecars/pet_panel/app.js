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

  const stage = $('pet-stage');
  const avatar = $('pet-avatar');
  const speechLine = $('speech-line');
  const dashboard = $('dashboard');
  const pinBtn = $('pin-btn');

  let isPinned = true;
  let lastSeenChatTotal = null;
  let latestData = null;
  let lineIdx = 0;

  pinBtn.addEventListener('click', () => {
    isPinned = !isPinned;
    pinBtn.classList.toggle('active', isPinned);
    pinBtn.textContent = isPinned ? '📌 Pinned' : '📌 Unpinned';
    if (isPinned) {
      dashboard.classList.remove('collapsed');
    }
  });

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
    const lastTurn = latestData.currentChat?.lastTurn || { input: 0, cache: 0, output: 0, total: 0 };
    const chatTotals = latestData.currentChat?.totals || { input: 0, cache: 0, output: 0, total: 0 };
    const week = latestData.thisWeek || { input: 0, cache: 0, output: 0, total: 0 };

    const lines = [
      `Last reply: In ${fmtTokens(lastTurn.input)} · Cache ${fmtTokens(lastTurn.cache)} · Out ${fmtTokens(lastTurn.output)} ✨`,
      `This chat: In ${fmtTokens(chatTotals.input)} · Cache ${fmtTokens(chatTotals.cache)} · Out ${fmtTokens(chatTotals.output)} 💙`,
      `This week: ${fmtTokens(week.total)} total (${fmtTokens(week.cache)} cached!) 🌟`,
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
      const last5h = data.last5h || { input: 0, cache: 0, output: 0, total: 0, steps: 0 };
      const week = data.thisWeek || { input: 0, cache: 0, output: 0, total: 0, steps: 0 };

      // Pet speech bubble live chat pill
      $('val-last-reply').textContent = fmtTokens(lastTurn.total);
      $('val-chat-total').textContent = fmtTokens(chatTotals.total);

      // Card 1: Overall Token Usage
      $('val-week').textContent = fmtTokens(week.total);
      $('sub-week').textContent = `${week.steps || 0} replies across ${data.conversationCount || 0} chats`;

      $('val-5h').textContent = fmtTokens(last5h.total);
      $('sub-5h').textContent = `${last5h.steps || 0} replies in last 5h`;

      // Card 2: Input, Cache, Output Breakdown
      const totalWeek = Math.max(1, week.total);
      const inPct = Math.min(100, Math.round((week.input / totalWeek) * 100));
      const cachePct = Math.min(100, Math.round((week.cache / totalWeek) * 100));
      const outPct = Math.min(100, Math.max(2, Math.round((week.output / totalWeek) * 100)));

      $('cache-hit-badge').textContent = `Cache: ${cachePct}%`;

      $('tok-in-week').textContent = `${fmtTokens(week.input)} (${inPct}%)`;
      $('bar-in').style.width = `${inPct}%`;
      $('sub-in').textContent = `5h: ${fmtTokens(last5h.input)} · Chat: ${fmtTokens(chatTotals.input)} · Reply: ${fmtTokens(lastTurn.input)}`;

      $('tok-cache-week').textContent = `${fmtTokens(week.cache)} (${cachePct}%)`;
      $('bar-cache').style.width = `${cachePct}%`;
      $('sub-cache').textContent = `5h: ${fmtTokens(last5h.cache)} · Chat: ${fmtTokens(chatTotals.cache)} · Reply: ${fmtTokens(lastTurn.cache)}`;

      const realOutPct = Math.round((week.output / totalWeek) * 100);
      $('tok-out-week').textContent = `${fmtTokens(week.output)} (${realOutPct}%)`;
      $('bar-out').style.width = `${outPct}%`;
      $('sub-out').textContent = `5h: ${fmtTokens(last5h.output)} · Chat: ${fmtTokens(chatTotals.output)} · Reply: ${fmtTokens(lastTurn.output)}`;

      if (lastSeenChatTotal !== null && chatTotals.total > lastSeenChatTotal) {
        triggerBounce();
        speechLine.textContent = `Reply: In ${fmtTokens(lastTurn.input)} · Cache ${fmtTokens(lastTurn.cache)} · Out ${fmtTokens(lastTurn.output)} ✨`;
      } else if (lastSeenChatTotal === null && lastTurn.total > 0) {
        speechLine.textContent = `Reply: In ${fmtTokens(lastTurn.input)} · Cache ${fmtTokens(lastTurn.cache)} · Out ${fmtTokens(lastTurn.output)} ✨`;
      }
      lastSeenChatTotal = chatTotals.total;
    } catch (err) {
      $('status-badge').textContent = 'Offline';
    }
  }

  poll();
  setInterval(poll, 1500);
})();
