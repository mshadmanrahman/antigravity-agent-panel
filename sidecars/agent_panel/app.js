(() => {
  const {
    ELEMENTS,
    dotsSvg,
    effortOfModel,
    elementForModel,
    renderCharacterSvg,
    shortModelName,
  } = window.AgentCharacters;

  const POLL_MS = 1500;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let quotaMode = localStorage.getItem('ap_quota_mode') === 'weekly' ? 'weekly' : 'reset';
  let lastSnap = null;

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
    if (m >= 1440) {
      const d = Math.floor(m / 1440);
      const h = Math.floor((m % 1440) / 60);
      return h ? `${d}d ${h}h` : `${d}d`;
    }
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return h ? (rem ? `${h}h ${rem}m` : `${h}h`) : `${rem}m`;
  };

  function syncThemeFromBackground() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }

  syncThemeFromBackground();
  new MutationObserver(syncThemeFromBackground).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  function currentConv() {
    return window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  async function fetchPanel() {
    const conv = currentConv();
    const path = `/api/panel${conv ? `?conversationId=${encodeURIComponent(conv)}` : ''}`;
    const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await fetcher(path, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function quotaStatus(pool) {
    const rem = typeof pool?.remainingPct === 'number' ? pool.remainingPct : 100;
    const used = typeof pool?.usedPct === 'number' ? pool.usedPct : 0;
    if (rem <= 15) return { text: 'critical', cls: 'over' };
    if (rem <= 40) return { text: 'low', cls: 'ahead' };
    if (used < 0.2) return { text: 'fresh', cls: 'fresh' };
    return { text: 'healthy', cls: 'under' };
  }

  function barColor(pool) {
    const rem = typeof pool?.remainingPct === 'number' ? pool.remainingPct : 100;
    if (rem <= 15) return 'var(--ap-danger)';
    if (rem <= 40) return 'var(--ap-warning)';
    return 'var(--ap-success)';
  }

  function renderLegend() {
    const box = $('legend-box');
    const items = [
      { el: ELEMENTS.hydrogen, model: 'Gemini 4 Hydrogen', persona: 'main' },
      { el: ELEMENTS.argon, model: 'Orchestrator (Argon)', persona: 'architect' },
      { el: ELEMENTS.flash, model: 'Gemini 3.8 Flash', persona: 'scout' },
      { el: ELEMENTS.carbon, model: 'Gemini 4 Carbon', persona: 'reviewer' },
      { el: ELEMENTS.guest, model: 'Claude 5.5', persona: 'developer' },
    ];
    box.innerHTML = items
      .map(
        (i) => `
        <div class="legend-item">
          <div class="legend-avatar">${renderCharacterSvg(i.model, i.persona, 'working')}</div>
          <div>
            <div style="font-weight:600">${esc(i.el.num)} ${esc(i.el.sym)} · ${esc(i.el.name)}</div>
            <div class="muted" style="font-size:10px">${esc(i.model)}</div>
          </div>
        </div>`,
      )
      .join('');
  }

  $('toggle-legend').addEventListener('click', () => {
    const box = $('legend-box');
    if (!box.innerHTML) renderLegend();
    box.classList.toggle('hidden');
  });

  function syncModeButtons() {
    $('mode-reset')?.classList.toggle('active', quotaMode === 'reset');
    $('mode-weekly')?.classList.toggle('active', quotaMode === 'weekly');
  }
  syncModeButtons();

  [$('mode-reset'), $('mode-weekly')].forEach((btn) => {
    btn?.addEventListener('click', () => {
      quotaMode = btn.dataset.mode === 'weekly' ? 'weekly' : 'reset';
      localStorage.setItem('ap_quota_mode', quotaMode);
      syncModeButtons();
      if (lastSnap) renderQuota(lastSnap.quota);
    });
  });

  function renderQuota(quota) {
    const grid = $('quota-grid');
    const credits = $('credits-bar');
    if (!quota) {
      $('plan-badge').textContent = 'LS offline';
      grid.innerHTML = '<div class="quota-card muted">Waiting for Antigravity language server quota data...</div>';
      credits.classList.add('hidden');
      return;
    }

    const isWeeklyMode = quotaMode === 'weekly' && quota.weekly;
    const pools = isWeeklyMode ? quota.weekly.pools : quota.pools;
    const planLabel = quota.planName || '';
    const hasNativeWeekly = isWeeklyMode && (pools || []).some((p) => p.source === 'native');
    $('plan-badge').textContent = isWeeklyMode
      ? hasNativeWeekly
        ? `${planLabel} · Weekly`
        : `${planLabel} · 7d (${quota.weekly.trackedDays}d tracked)`
      : planLabel;

    grid.innerHTML = (pools || [])
      .map((p) => {
        const badge = quotaStatus(p);
        const col = barColor(p);
        const timeLeftPct = Math.max(1, Math.min(99, 100 - (p.elapsedPct || 0)));
        const metaLeft = `${p.remainingPct}% left (${p.usedPct}% used)`;
        const metaRight = isWeeklyMode
          ? p.source === 'native'
            ? `resets ${fmtLeft(p.leftMs)}${p.tokens7d ? ` · ${fmtTokens(p.tokens7d)} tok` : ''}`
            : p.tokens7d
              ? `${fmtTokens(p.tokens7d)} tok · ${p.note || ''}`
              : p.note || `${fmtLeft(p.leftMs)}`
          : `resets ${fmtLeft(p.leftMs)}${p.weekly ? ` · 7d ${Math.round(p.weekly.remainingPct)}% left` : ''}`;
        return `
        <div class="quota-card">
          <div class="quota-top">
            <span class="quota-name">${esc(p.name)} <span class="muted mono" style="font-weight:400">(${esc(p.windowLabel)})</span></span>
            <span class="verdict ${badge.cls}">${esc(badge.text)}</span>
          </div>
          <div class="meter-track" title="${p.remainingPct}% quota left vs ${timeLeftPct}% window time left">
            <div class="meter-fill" style="width:${Math.max(0, Math.min(100, p.remainingPct))}%;background:${col}"></div>
            <div class="meter-marker" style="left:${timeLeftPct}%"></div>
          </div>
          <div class="quota-meta mono">
            <span>${esc(metaLeft)}</span>
            <span>${esc(metaRight)}</span>
          </div>
        </div>`;
      })
      .join('');

    const parts = [];
    if (isWeeklyMode && quota.weekly) {
      parts.push(`7d burn: ${fmtTokens(quota.weekly.totalTokens7d)} across ${quota.weekly.totalChats7d} chats`);
      if (quota.weekly.promptUsedPct != null) parts.push(`Monthly prompt: ${quota.weekly.promptUsedPct}% used`);
    } else {
      if (quota.promptCredits != null) parts.push(`Prompt credits: ${quota.promptCredits}`);
      if (quota.flowCredits != null) parts.push(`Flow credits: ${quota.flowCredits}`);
    }
    if (quota.unavailable?.length) parts.push(`Locked: ${quota.unavailable.join(', ')}`);
    if (parts.length) {
      credits.textContent = parts.join('  ·  ');
      credits.classList.remove('hidden');
    } else {
      credits.classList.add('hidden');
    }
  }

  function renderAgentRow(a) {
    const el = elementForModel(a.model);
    const eff = effortOfModel(a.model);
    const isWorking = a.status === 'working';
    const ctxClass = a.ctxPct >= 80 ? 'high' : a.ctxPct >= 60 ? 'warn' : '';
    const canOpen = Boolean(window.sidecar?.ui?.toggleConversation && a.kind !== 'main' && a.id);

    return `
    <div class="agent-row ${a.status === 'done' ? 'is-done' : ''}" data-conv="${esc(a.id)}">
      <div class="avatar-box">${renderCharacterSvg(a.model, a.persona, a.status)}</div>
      <div class="agent-body">
        <div class="agent-top">
          <span class="agent-title">${esc(a.title)}</span>
          <span class="badge el-${el.id}">${esc(el.num)} ${esc(el.sym)}</span>
          <span class="badge">${esc(shortModelName(a.model))}${eff ? ` · ${esc(eff.label)}` : ''}</span>
        </div>
        <div class="agent-activity">
          ${isWorking ? dotsSvg('var(--ap-primary)') : `<span>${a.status === 'done' ? '✓' : '◦'}</span>`}
          <span>${esc(a.activity)}</span>
          ${canOpen ? `<button type="button" class="ghost-btn open-conv" data-open="${esc(a.id)}" style="margin-left:auto">Open</button>` : ''}
        </div>
      </div>
      <div class="agent-metrics mono">
        <div class="ctx-row" title="Latest context fill (${fmtTokens(a.ctxTokens)} / ${fmtTokens(a.ctxWindow)})">
          <div class="ctx-bar"><div class="ctx-fill ${ctxClass}" style="width:${a.ctxPct}%"></div></div>
          <span>${a.ctxPct}%</span>
        </div>
        <div class="muted">${fmtTokens(a.tokens)} tok · ${a.cacheHitPct}% cache · ${fmtClock(a.durationMs)}</div>
      </div>
    </div>`;
  }

  function render(snap) {
    lastSnap = snap;
    const s = snap.summary || {};
    $('live-dot').classList.toggle('idle', !s.activeCount);
    $('summary-line').textContent = `${s.activeCount || 0} active · ${fmtTokens(s.totalTokens || 0)} · ${fmtClock(s.durationMs || 0)}`;
    $('crew-totals').textContent = `${s.totalAgents || 0} agent${s.totalAgents === 1 ? '' : 's'} · ${s.totalSteps || 0} steps`;

    renderQuota(snap.quota);

    const list = $('crew-list');
    if (!snap.agents?.length) {
      list.innerHTML = `<div class="empty-state">No active conversation transcript yet. Send a message in Antigravity to wake your Hydrogen crew.</div>`;
    } else {
      list.innerHTML = snap.agents.map(renderAgentRow).join('');
    }

    list.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.sidecar?.ui?.toggleConversation?.(btn.dataset.open);
      });
    });

    const otherSec = $('other-section');
    const otherList = $('other-list');
    if (snap.otherRunning?.length) {
      otherSec.classList.remove('hidden');
      $('other-count').textContent = `${snap.otherRunning.length} running`;
      otherList.innerHTML = snap.otherRunning
        .map(
          (c) => `
          <div class="agent-row">
            <div class="avatar-box">${renderCharacterSvg('Hydrogen', 'developer', 'working')}</div>
            <div class="agent-body">
              <div class="agent-top">
                <span class="agent-title">${esc(c.title)}</span>
                <span class="badge">${c.steps} steps</span>
              </div>
              <div class="agent-activity">${dotsSvg('var(--ap-primary)')}<span>Running in parallel conversation</span></div>
            </div>
            ${
              window.sidecar?.ui?.toggleConversation
                ? `<button type="button" class="ghost-btn" data-open-other="${esc(c.id)}">Open</button>`
                : ''
            }
          </div>`,
        )
        .join('');
      otherList.querySelectorAll('[data-open-other]').forEach((btn) => {
        btn.addEventListener('click', () => {
          window.sidecar?.ui?.toggleConversation?.(btn.dataset.openOther);
        });
      });
    } else {
      otherSec.classList.add('hidden');
    }
  }

  async function tick() {
    try {
      const snap = await fetchPanel();
      render(snap);
    } catch (err) {
      $('summary-line').textContent = `Offline (${err.message})`;
    } finally {
      setTimeout(tick, POLL_MS);
    }
  }

  tick();
})();
