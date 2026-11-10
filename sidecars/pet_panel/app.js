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
    if (!b) return 'In: 0 · Cache: 0 · Out: 0';
    return `In ${fmtTokens(b.input)} · Cache ${fmtTokens(b.cache)} · Out ${fmtTokens(b.output)}`;
  }

  const stage = $('pet-stage');
  const avatar = $('pet-avatar');
  const bubble = $('speech-bubble');

  let lastSeenChatTotal = null;
  let latestData = null;
  let lineIdx = 0;

  function triggerBounce() {
    avatar.classList.remove('bounce');
    void avatar.offsetWidth;
    avatar.classList.add('bounce');
  }

  stage.addEventListener('click', () => {
    triggerBounce();
    if (!latestData) return;
    const replyTok = fmtTokens(latestData.currentChat?.lastTurn?.total || 0);
    const chatTok = fmtTokens(latestData.currentChat?.totals?.total || 0);
    const weekTok = fmtTokens(latestData.thisWeek?.total || 0);
    const lines = [
      `Last reply used ${replyTok} tokens! ✨`,
      `This chat is at ${chatTok} tokens so far~ 💜`,
      `You've used ${weekTok} tokens this week! 🌟`,
      `Click me anytime to check your usage, nya~ 🐾`,
    ];
    lineIdx = (lineIdx + 1) % lines.length;
    bubble.textContent = lines[lineIdx];
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
      $('val-chat-count').textContent = `${data.conversationCount || 0} chats`;

      const lastTurn = data.currentChat?.lastTurn || { input: 0, cache: 0, output: 0, total: 0 };
      const chatTotals = data.currentChat?.totals || { input: 0, cache: 0, output: 0, total: 0 };

      $('val-last-reply').textContent = fmtTokens(lastTurn.total);
      $('sub-last-reply').textContent = fmtBreakdown(lastTurn);

      $('val-chat-total').textContent = fmtTokens(chatTotals.total);
      $('sub-chat-total').textContent = fmtBreakdown(chatTotals);

      $('val-5h').textContent = fmtTokens(data.last5h?.total || 0);
      $('sub-5h').textContent = fmtBreakdown(data.last5h);

      $('val-week').textContent = fmtTokens(data.thisWeek?.total || 0);
      $('sub-week').textContent = fmtBreakdown(data.thisWeek);

      // React with a bounce + speech bubble update when new tokens arrive in this chat!
      if (lastSeenChatTotal !== null && chatTotals.total > lastSeenChatTotal) {
        triggerBounce();
        bubble.textContent = `New reply! +${fmtTokens(lastTurn.total)} tokens (Chat: ${fmtTokens(chatTotals.total)}) ✨`;
      } else if (lastSeenChatTotal === null && chatTotals.total > 0) {
        bubble.textContent = `Last reply: ${fmtTokens(lastTurn.total)} · This chat: ${fmtTokens(chatTotals.total)} ✨`;
      }
      lastSeenChatTotal = chatTotals.total;
    } catch (err) {
      $('status-badge').textContent = 'Offline';
    }
  }

  poll();
  setInterval(poll, 1500);
})();
