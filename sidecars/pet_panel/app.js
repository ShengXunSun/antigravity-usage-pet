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

  const stage = $('pet-stage');
  const avatar = $('pet-avatar');
  const bubble = $('speech-bubble');
  const lines = [
    "Hi! I'm your Gemini Usage Pet ✨",
    "Nya~ Ready to watch your tokens! 💜",
    "v0.1-base sidecar is live! 🌟",
  ];
  let lineIdx = 0;

  stage.addEventListener('click', () => {
    avatar.classList.remove('bounce');
    void avatar.offsetWidth;
    avatar.classList.add('bounce');
    lineIdx = (lineIdx + 1) % lines.length;
    bubble.textContent = lines[lineIdx];
  });

  async function poll() {
    try {
      const conv = currentConv();
      const q = conv ? `?conversationId=${encodeURIComponent(conv)}` : '';
      const data = await getJson(`/api/status${q}`);
      $('status-badge').textContent = data.ok ? 'Live' : 'Error';
      $('val-version').textContent = data.version || '0.1.1';
      $('val-conv').textContent = data.conversationId ? data.conversationId.slice(0, 8) + '…' : 'None';
      $('val-count').textContent = String(data.conversationCount ?? 0);
    } catch (err) {
      $('status-badge').textContent = 'Offline';
    }
  }

  poll();
  setInterval(poll, 2000);
})();
