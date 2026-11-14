(() => {
  const { dotsSvg, elementForModel, renderCharacterSvg, shortModelName } = window.AgentCharacters;

  const POLL_MS = 1400;
  const DIAL_R = 19;
  const DIAL_CIRC = 2 * Math.PI * DIAL_R;
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtTokens = (n) => {
    if (!n) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
  };

  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };

  const fmtLeft = (ms) => {
    const m = Math.max(0, Math.round((ms || 0) / 60000));
    if (m >= 1440) return `${Math.floor(m / 1440)}d`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return h ? `${h}h ${rem}m` : `${rem}m`;
  };

  let expanded = false;
  let liveSelectedModel = '';
  let lastSnap = null;

  window.__apSetSelectedModel = (modelName) => {
    const clean = String(modelName || '').trim();
    if (!clean || clean === liveSelectedModel) return;
    liveSelectedModel = clean;
    if (lastSnap) render(lastSnap);
  };

  // Automatically track macOS / host light-dark preference.
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  function syncSystemTheme() {
    document.documentElement.dataset.theme = darkQuery.matches ? 'dark' : 'light';
  }
  localStorage.removeItem('ap_hud_theme');
  syncSystemTheme();
  darkQuery.addEventListener('change', syncSystemTheme);

  $('hud-expand').addEventListener('click', () => {
    expanded = !expanded;
    $('hud-drawer').classList.toggle('hidden', !expanded);
    $('hud-expand').setAttribute('aria-expanded', String(expanded));
    window.webkit?.messageHandlers?.hud?.postMessage({ type: 'expand', expanded });
    if (lastSnap && expanded) renderDrawer(lastSnap);
  });

  $('hud-hide').addEventListener('click', () => {
    expanded = false;
    $('hud-drawer').classList.add('hidden');
    $('hud-expand').setAttribute('aria-expanded', 'false');
    $('hud-bar').classList.add('hidden');
    $('hud-mini').classList.remove('hidden');
    window.webkit?.messageHandlers?.hud?.postMessage({ type: 'minimize', minimized: true });
  });

  $('hud-mini').addEventListener('click', () => {
    $('hud-mini').classList.add('hidden');
    $('hud-bar').classList.remove('hidden');
    window.webkit?.messageHandlers?.hud?.postMessage({ type: 'minimize', minimized: false });
  });

  $('hud-bar').addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    window.webkit?.messageHandlers?.hud?.postMessage({ type: 'startDrag' });
  });

  function barColor(verdict) {
    if (verdict === 'over pace') return 'var(--hud-danger)';
    if (verdict === 'ahead of pace') return 'var(--hud-warning)';
    if (verdict === 'under pace') return 'var(--hud-success)';
    return 'var(--hud-primary)';
  }

  function findFocusPool(pools, mainModel) {
    if (!pools?.length) return null;
    const s = String(mainModel || '').toLowerCase();
    if (s.includes('argon')) return pools.find((p) => p.name.includes('Argon')) || pools[0];
    if (s.includes('claude') || s.includes('gpt')) return pools.find((p) => p.name.includes('Claude')) || pools[0];
    return pools.find((p) => p.name.includes('Hydrogen')) || pools[0];
  }

  function renderCrew(snap) {
    const crewEl = $('hud-crew');
    const agents = snap.agents || [];
    if (!agents.length) {
      crewEl.innerHTML = `<div class="hud-empty muted">No active chat transcript yet</div>`;
      return;
    }

    const main = agents[0];
    const activeModel = liveSelectedModel || main.model;
    const el = elementForModel(activeModel);
    const activeSubs = agents.slice(1).filter((a) => a.status === 'working').length;
    const isWorking = main.status === 'working';

    crewEl.innerHTML = `
      <div class="hero-agent" title="${esc(main.title)} (${esc(shortModelName(activeModel))})">
        <div class="hero-sprite">${renderCharacterSvg(activeModel, main.persona, main.status)}</div>
        <div class="hero-text">
          <div class="hero-top">
            <span class="hero-name">${esc(el.name)}</span>
            <span class="pill mono">${main.ctxPct}% ctx</span>
            ${activeSubs > 0 ? `<span class="pill active">+${activeSubs} active</span>` : ''}
          </div>
          <div class="hero-sub">
            ${isWorking ? dotsSvg('var(--hud-primary)') : `<span>◦</span>`}
            <span class="hero-act">${esc(main.activity)}</span>
            <span class="mono">· ${fmtClock(main.durationMs)}</span>
          </div>
        </div>
      </div>`;
  }

  function renderQuotas(snap) {
    const el = $('hud-quotas');
    const quota = snap.quota;
    if (!quota) {
      el.innerHTML = `<span class="muted mono">LS offline</span>`;
      return;
    }
    const pools = quota.pools || [];
    const mainModel = liveSelectedModel || snap.agents?.[0]?.model || 'Hydrogen';
    const focus = findFocusPool(pools, mainModel);

    if (!focus) {
      el.innerHTML = '';
      return;
    }

    const focusUsed = Math.round(focus.usedPct);
    const focusRight = `${focusUsed}% used · ${fmtLeft(focus.leftMs)}`;

    el.innerHTML = `
      <div class="q-focus" title="${esc(focus.name)} (${esc(focus.windowLabel)}): ${focus.usedPct}% used vs ${focus.elapsedPct}% elapsed (${esc(focus.verdict)})">
        <div class="q-focus-top">
          <span class="q-title">${esc(focus.name.split(' / ')[0])} · ${esc(focus.windowLabel)}</span>
          <span class="q-meta mono">${esc(focusRight)}</span>
        </div>
        <div class="meter-track">
          <div class="meter-fill" style="width:${Math.min(100, focus.usedPct)}%;background:${barColor(focus.verdict)}"></div>
          <div class="meter-marker" style="left:${Math.min(99, focus.elapsedPct)}%"></div>
        </div>
      </div>`;
  }

  function renderDrawer(snap) {
    if (!expanded) return;
    const s = snap.summary || {};
    const q = snap.quota;
    $('drawer-title').textContent = 'All Models & Active Crew';
    $('drawer-meta').textContent = `${fmtTokens(s.totalTokens || 0)} tok · ${s.totalSteps || 0} steps${
      q?.weekly ? ` · ${fmtTokens(q.weekly.totalTokens7d)} (7d)` : ''
    }`;

    const pools = q?.pools || [];
    $('drawer-quotas').innerHTML = pools
      .map(
        (p) => `
        <div class="dq-card">
          <div class="dq-top">
            <span>${esc(p.name)} (${esc(p.windowLabel)})</span>
            <span class="mono">${Math.round(p.usedPct)}%</span>
          </div>
          <div class="meter-track">
            <div class="meter-fill" style="width:${Math.min(100, p.usedPct)}%;background:${barColor(p.verdict)}"></div>
            <div class="meter-marker" style="left:${Math.min(99, p.elapsedPct)}%"></div>
          </div>
          <div class="muted mono">${p.remainingPct}% left · ${fmtLeft(p.leftMs)}</div>
        </div>`,
      )
      .join('');

    const list = $('drawer-agents');
    if (!snap.agents?.length) {
      list.innerHTML = `<div class="muted">No active agents in current conversation.</div>`;
      return;
    }
    list.innerHTML = snap.agents
      .map(
        (a) => `
        <div class="drawer-row">
          <div class="drawer-sprite">${renderCharacterSvg(a.model, a.persona, a.status)}</div>
          <div class="drawer-row-main">
            <div class="drawer-row-title">${esc(a.title)} · <span class="muted">${esc(shortModelName(a.model))}</span></div>
            <div class="drawer-row-act">${esc(a.activity)}</div>
          </div>
          <div class="mono muted">${a.ctxPct}% ctx · ${fmtTokens(a.tokens)} · ${fmtClock(a.durationMs)}</div>
        </div>`,
      )
      .join('');
  }

  function renderMiniDial(snap) {
    const mini = $('hud-mini');
    const spriteEl = $('hud-mini-sprite');
    const arc = $('dial-arc');
    const pctEl = $('hud-mini-pct');
    if (!mini || !spriteEl || !arc || !pctEl) return;

    const main = snap.agents?.[0];
    const mainModel = liveSelectedModel || main?.model || 'Hydrogen';
    const elem = elementForModel(mainModel);
    const colorVar = `var(--el-${elem.id}-body)`;
    const pools = snap.quota?.pools || [];
    const focus = findFocusPool(pools, mainModel);
    const pct = focus ? Math.max(0, Math.min(100, focus.usedPct)) : 0;
    const rounded = Math.round(pct);

    spriteEl.innerHTML = renderCharacterSvg(
      mainModel,
      main?.persona || 'main',
      main?.status || 'waiting',
    );
    arc.style.stroke = colorVar;
    arc.style.strokeDasharray = `${DIAL_CIRC} ${DIAL_CIRC}`;
    arc.style.strokeDashoffset = String(DIAL_CIRC * (1 - pct / 100));
    pctEl.textContent = focus ? `${rounded}%` : '--';

    mini.title = focus
      ? `${elem.name} (${focus.windowLabel}): ${rounded}% used · ${fmtLeft(focus.leftMs)} left (click to expand)`
      : `${elem.name} (click to expand)`;
  }

  function render(snap) {
    lastSnap = snap;
    renderMiniDial(snap);
    renderCrew(snap);
    renderQuotas(snap);
    renderDrawer(snap);
  }

  async function tick() {
    try {
      const res = await fetch('/api/panel', { method: 'GET' });
      if (res.ok) render(await res.json());
    } catch {
      // Retry next interval.
    } finally {
      setTimeout(tick, POLL_MS);
    }
  }

  tick();
})();
