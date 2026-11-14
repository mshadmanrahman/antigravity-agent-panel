/**
 * Elemental Agent Panel sidecar backend for Google Antigravity.
 *
 * Read-only telemetry aggregator:
 * - LanguageServerService/GetUserStatus -> plan credits, per-model quota & pace
 * - LanguageServerService/GetAllCascadeTrajectories -> running/idle status
 * - <appData>/brain/<convId>/.system_generated/logs/transcript.jsonl -> tokens, context, tools, subagents
 * - <appData>/brain/<convId>/.system_generated/swarm/members.json -> swarm workers (when active)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const FIVE_HOURS_MS = 5 * 3600 * 1000;
const WEEK_MS = 7 * 24 * 3600 * 1000;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/characters.js': ['characters.js', 'application/javascript; charset=utf-8'],
  '/hud.css': ['hud.css', 'text/css; charset=utf-8'],
  '/hud.js': ['hud.js', 'application/javascript; charset=utf-8'],
};

// ---------------------------------------------------------------------------
// App data and Language Server discovery
// ---------------------------------------------------------------------------

function findAllAppDataDirs() {
  const candidates = [];
  const exeData = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (exeData) {
    for (let d = exeData; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        candidates.push(dirname(d));
        break;
      }
    }
  }
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    candidates.push(process.env.ANTIGRAVITY_APP_DATA_DIR);
  }
  candidates.push(
    join(homedir(), '.gemini', 'antigravity'),
    join(homedir(), '.gemini', 'antigravity-ide'),
    join(homedir(), '.gemini', 'antigravity-cli'),
  );

  const seen = new Set();
  const dirs = [];
  for (const dir of candidates) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (existsSync(join(dir, 'brain'))) dirs.push(dir);
  }
  return dirs;
}

function findLedgerPath(appDirs) {
  const primary = appDirs[0] || join(homedir(), '.gemini', 'antigravity');
  return join(primary, 'sidecar_data', 'antigravity-agent-panel', 'weekly-ledger.json');
}

function findTranscriptPath(appDirs, convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const dir of appDirs) {
    const p = join(dir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

function findSwarmMembersPath(appDirs, convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const dir of appDirs) {
    const p = join(dir, 'brain', convId, '.system_generated', 'swarm', 'members.json');
    if (existsSync(p)) return p;
  }
  return null;
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function discoverLanguageServer(appDirs) {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    return {
      address: process.env.ANTIGRAVITY_LS_ADDRESS,
      csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN,
    };
  }
  const files = [];
  for (const dir of appDirs) {
    const daemonDir = join(dir, 'daemon');
    try {
      for (const f of readdirSync(daemonDir)) {
        if (!f.endsWith('.json')) continue;
        const p = join(daemonDir, f);
        try {
          files.push({ p, mtime: statSync(p).mtimeMs });
        } catch {
          // Ignore disappeared daemon files.
        }
      }
    } catch {
      // Directory may not have daemon files (e.g., CLI).
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { p } of files) {
    try {
      const info = JSON.parse(readFileSync(p, 'utf-8'));
      if (!info.httpPort || !info.csrfToken) continue;
      if (info.pid && !isPidAlive(Number(info.pid))) continue;
      return { address: `127.0.0.1:${info.httpPort}`, csrfToken: info.csrfToken };
    } catch {
      // Ignore torn or unreadable daemon files.
    }
  }
  return null;
}

const rpcCache = new Map();
async function callLsRpc(ls, method, body = {}, ttlMs = 2000) {
  if (!ls) return null;
  const key = `${ls.address}:${method}`;
  const now = Date.now();
  const cached = rpcCache.get(key);
  if (cached && now - cached.at < ttlMs) return cached.data;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`http://${ls.address}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': ls.csrfToken,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return cached?.data ?? null;
    const data = await res.json();
    rpcCache.set(key, { at: now, data });
    return data;
  } catch {
    return cached?.data ?? null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Quota pools and pace calculation
// ---------------------------------------------------------------------------

function familyOf(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('hydrogen')) return 'Hydrogen';
  if (s.includes('argon')) return 'Argon';
  if (s.includes('carbon')) return 'Carbon';
  if (s.includes('flash')) return '3.8 Flash';
  if (s.includes('opus')) return 'Claude Opus';
  if (s.includes('sonnet')) return 'Claude Sonnet';
  if (s.includes('gpt')) return 'GPT-OSS';
  return label;
}

function summarizePoolName(families) {
  const uniq = [...new Set(families)];
  if (uniq.includes('Hydrogen') && uniq.includes('3.8 Flash')) return 'Hydrogen / Flash';
  if (uniq.includes('Argon')) return 'Argon';
  if (uniq.some((f) => f.startsWith('Claude')) || uniq.includes('GPT-OSS')) return 'Claude / OSS';
  return uniq.slice(0, 2).join(' / ');
}

function buildQuotaSnapshot(userStatus, now) {
  const us = userStatus?.userStatus;
  if (!us) return null;
  const planInfo = us.planStatus?.planInfo || {};
  const configs = us.cascadeModelConfigData?.clientModelConfigs || [];

  const pools = new Map();
  const unavailable = [];
  const models = [];

  for (const cfg of configs) {
    const label = cfg.label || cfg.modelOrAlias?.model || 'Unknown';
    const q = cfg.quotaInfo;
    if (!q || typeof q.remainingFraction !== 'number' || !q.resetTime) {
      if (cfg.tagTitle === 'Unavailable') unavailable.push(label);
      continue;
    }
    models.push({
      label,
      id: cfg.modelOrAlias?.model || '',
      remainingFraction: q.remainingFraction,
      resetTime: q.resetTime,
      tag: cfg.tagTitle || null,
    });
    const fracBucket = Math.round(q.remainingFraction * 10000);
    const poolKey = `${q.resetTime}|${fracBucket}`;
    if (!pools.has(poolKey)) {
      pools.set(poolKey, {
        resetTime: q.resetTime,
        remainingFraction: q.remainingFraction,
        families: [],
        labels: [],
      });
    }
    const p = pools.get(poolKey);
    p.families.push(familyOf(label));
    p.labels.push(label);
  }

  const quotaPools = [];
  for (const p of pools.values()) {
    const resetMs = Date.parse(p.resetTime);
    const leftMs = Math.max(0, Number.isFinite(resetMs) ? resetMs - now : 0);
    const isWeekly = leftMs > 24 * 3600 * 1000;
    const windowMs = isWeekly ? Math.max(WEEK_MS, leftMs) : Math.max(FIVE_HOURS_MS, leftMs);
    const elapsedFrac = Math.min(1, Math.max(0.01, 1 - leftMs / windowMs));
    const usedPct = Math.max(0, Math.min(100, (1 - p.remainingFraction) * 100));
    const elapsedPct = elapsedFrac * 100;
    const pace = usedPct / elapsedPct;
    const verdict =
      usedPct < 0.2
        ? 'fresh'
        : pace > 1.15
          ? 'over pace'
          : pace > 1.0
            ? 'ahead of pace'
            : pace < 0.85
              ? 'under pace'
              : 'on pace';

    quotaPools.push({
      name: summarizePoolName(p.families),
      windowLabel: isWeekly ? '7d' : '5h',
      usedPct: Math.round(usedPct * 10) / 10,
      remainingPct: Math.round(p.remainingFraction * 1000) / 10,
      elapsedPct: Math.round(elapsedPct),
      pace: Math.round(pace * 100) / 100,
      verdict,
      resetTime: p.resetTime,
      leftMs,
      models: [...new Set(p.families)],
    });
  }

  // Put active-use or short-window pools first, then weekly pools.
  quotaPools.sort((a, b) => (b.usedPct > 0) - (a.usedPct > 0) || a.leftMs - b.leftMs);

  return {
    planName: planInfo.planName || 'Pro',
    promptCredits: us.planStatus?.availablePromptCredits ?? null,
    flowCredits: us.planStatus?.availableFlowCredits ?? null,
    monthlyPromptCredits: planInfo.monthlyPromptCredits ?? null,
    monthlyFlowCredits: planInfo.monthlyFlowCredits ?? null,
    pools: quotaPools,
    unavailable,
  };
}

// ---------------------------------------------------------------------------
// Rolling 7-day ledger & brain token rollup
// ---------------------------------------------------------------------------

let ledgerCache = null;
let lastLedgerWriteAt = 0;

function loadLedger(ledgerPath, now) {
  if (ledgerCache) return ledgerCache;
  try {
    if (existsSync(ledgerPath)) {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        ledgerCache = {
          firstSeenTs: Number(parsed.firstSeenTs) || now,
          pools: parsed.pools && typeof parsed.pools === 'object' ? parsed.pools : {},
        };
        return ledgerCache;
      }
    }
  } catch {
    // Recreate ledger if corrupt.
  }
  ledgerCache = { firstSeenTs: now, pools: {} };
  return ledgerCache;
}

function recordQuotaToLedger(appDirs, quota, now) {
  if (!quota?.pools?.length) return null;
  const ledgerPath = findLedgerPath(appDirs);
  const ledger = loadLedger(ledgerPath, now);
  const cutoff = now - WEEK_MS;
  let dirty = false;

  for (const p of quota.pools) {
    if (!ledger.pools[p.name]) ledger.pools[p.name] = { cycles: [] };
    const entry = ledger.pools[p.name];
    entry.cycles = (entry.cycles || []).filter((c) => (Date.parse(c.resetTime) || c.lastTs || 0) >= cutoff);

    let cycle = entry.cycles.find((c) => c.resetTime === p.resetTime);
    if (!cycle) {
      cycle = {
        resetTime: p.resetTime,
        windowLabel: p.windowLabel,
        firstTs: now,
        lastTs: now,
        maxUsedPct: p.usedPct,
      };
      entry.cycles.push(cycle);
      dirty = true;
    } else {
      if (p.usedPct > cycle.maxUsedPct) {
        cycle.maxUsedPct = p.usedPct;
        dirty = true;
      }
      if (now - (cycle.lastTs || 0) > 60_000) {
        cycle.lastTs = now;
        dirty = true;
      }
    }
  }

  if (dirty && now - lastLedgerWriteAt > 15_000) {
    try {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(ledger), 'utf-8');
      lastLedgerWriteAt = now;
    } catch {
      // Non-fatal if sidecar data folder is read-only.
    }
  }
  return ledger;
}

let weeklyRollupCache = { at: 0, data: null };

function computeSevenDayRollup(appDirs, now) {
  if (weeklyRollupCache.data && now - weeklyRollupCache.at < 20_000) {
    return weeklyRollupCache.data;
  }
  const cutoff = now - WEEK_MS;
  let totalTokens7d = 0;
  let totalChats7d = 0;
  const byPool = { 'Hydrogen / Flash': 0, Argon: 0, 'Claude / OSS': 0 };

  for (const dir of appDirs) {
    const brainDir = join(dir, 'brain');
    let ids = [];
    try {
      ids = readdirSync(brainDir);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!ID_RE.test(id)) continue;
      const p = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      const parsed = readTranscriptCached(p);
      if (!parsed || !parsed.totalTokens) continue;
      totalChats7d += 1;
      totalTokens7d += parsed.totalTokens;
      const m = String(parsed.model || '').toLowerCase();
      if (m.includes('argon')) byPool.Argon += parsed.totalTokens;
      else if (m.includes('claude') || m.includes('gpt')) byPool['Claude / OSS'] += parsed.totalTokens;
      else byPool['Hydrogen / Flash'] += parsed.totalTokens;
    }
  }

  const data = { totalTokens7d, totalChats7d, byPool };
  weeklyRollupCache = { at: now, data };
  return data;
}

function buildWeeklyQuotaView(appDirs, quota, now) {
  if (!quota) return null;
  const ledger = recordQuotaToLedger(appDirs, quota, now);
  const rollup = computeSevenDayRollup(appDirs, now);
  const trackedMs = Math.min(WEEK_MS, Math.max(0, now - (ledger?.firstSeenTs || now)));
  const trackedDays = Math.max(1, Math.round((trackedMs / (24 * 3600 * 1000)) * 10) / 10);

  // Elapsed fraction of the current ISO week (Mon 00:00 local -> +7d) for calendar weekly context.
  const d = new Date(now);
  const dayFromMon = (d.getDay() + 6) % 7;
  const monStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dayFromMon).getTime();
  const weekElapsedPct = Math.max(1, Math.min(100, Math.round(((now - monStart) / WEEK_MS) * 100)));

  const pools = (quota.pools || []).map((p) => {
    if (p.windowLabel === '7d') {
      return {
        ...p,
        tokens7d: rollup.byPool[p.name] || 0,
        cycles7d: 1,
        note: `${p.usedPct}% / ${p.elapsedPct}% wk`,
      };
    }

    const entry = ledger?.pools?.[p.name];
    const cycles = entry?.cycles || [];
    const avgUsed = cycles.length
      ? Math.round((cycles.reduce((s, c) => s + (c.maxUsedPct || 0), 0) / cycles.length) * 10) / 10
      : p.usedPct;
    const sumUsed = cycles.length
      ? Math.round(cycles.reduce((s, c) => s + (c.maxUsedPct || 0), 0) * 10) / 10
      : p.usedPct;
    const tokens7d = rollup.byPool[p.name] || 0;
    const meterPct = Math.min(100, avgUsed);
    const ratio = meterPct / Math.max(1, p.elapsedPct);
    const verdict =
      meterPct < 0.2 && tokens7d === 0
        ? 'fresh'
        : ratio > 1.15
          ? 'over pace'
          : ratio > 1.0
            ? 'ahead of pace'
            : ratio < 0.85
              ? 'under pace'
              : 'on pace';

    return {
      ...p,
      windowLabel: '7d',
      usedPct: meterPct,
      remainingPct: Math.round((100 - meterPct) * 10) / 10,
      elapsedPct: weekElapsedPct,
      sumUsedPct: sumUsed,
      cycles7d: Math.max(1, cycles.length),
      tokens7d,
      verdict,
      note: `${cycles.length || 1}x 5h · avg ${avgUsed}%`,
    };
  });

  const promptPct =
    quota.monthlyPromptCredits && quota.promptCredits != null
      ? Math.round(((quota.monthlyPromptCredits - quota.promptCredits) / quota.monthlyPromptCredits) * 100)
      : null;
  const flowPct =
    quota.monthlyFlowCredits && quota.flowCredits != null
      ? Math.round(((quota.monthlyFlowCredits - quota.flowCredits) / quota.monthlyFlowCredits) * 100)
      : null;

  return {
    trackedDays,
    weekElapsedPct,
    totalTokens7d: rollup.totalTokens7d,
    totalChats7d: rollup.totalChats7d,
    promptUsedPct: promptPct,
    flowUsedPct: flowPct,
    pools,
  };
}

// ---------------------------------------------------------------------------
// Transcript and subagent parsing (mtime + size cached)
// ---------------------------------------------------------------------------

const transcriptCache = new Map();

function readTranscriptCached(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = transcriptCache.get(path);
  if (hit && hit.key === key) return hit.parsed;

  let text = '';
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseTranscriptLines(text);
  transcriptCache.set(path, { key, parsed });
  return parsed;
}

function modelWindow(modelLabel) {
  const s = String(modelLabel || '').toLowerCase();
  if (s.includes('claude')) return 200_000;
  if (s.includes('gpt')) return 128_000;
  return 1_000_000;
}

function summarizeToolCall(tc) {
  if (!tc?.name) return 'Working';
  const name = tc.name;
  let args = tc.args;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  args = args || {};
  const stripQuotes = (v) => String(v ?? '').replace(/^"|"$/g, '');
  if (args.toolSummary) return stripQuotes(args.toolSummary);
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
    const p = stripQuotes(args.Path || args.path);
    return p ? `${name.replace('_', ' ')} ${basename(p)}` : name.replace('_', ' ');
  }
  if (name === 'run_command') {
    const cmd = stripQuotes(args.CommandLine).split(/\s+/)[0];
    return cmd ? `run ${cmd}` : 'run command';
  }
  if (name === 'search_web') return `search ${stripQuotes(args.query).slice(0, 32)}`;
  if (name === 'invoke_subagent') return `spawn ${stripQuotes(args.Role || args.TypeName || 'subagent')}`;
  return name.replace(/_/g, ' ');
}

function parseSubagentArgs(rawArgs) {
  let args = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return [];
    }
  }
  if (!args || typeof args !== 'object') return [];
  if (typeof args.Subagents === 'string') {
    try {
      const arr = JSON.parse(args.Subagents);
      if (Array.isArray(arr)) return arr;
    } catch {
      // Ignore malformed legacy Subagents string.
    }
  }
  return [
    {
      Role: String(args.Role || '').replace(/^"|"$/g, ''),
      TypeName: String(args.TypeName || '').replace(/^"|"$/g, ''),
      Model: String(args.Model || '').replace(/^"|"$/g, ''),
      Prompt: String(args.Prompt || '').replace(/^"|"$/g, ''),
    },
  ];
}

function parseTranscriptLines(text) {
  const lines = text.split('\n');
  let model = '';
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let latestCtx = 0;
  let steps = 0;
  let startedAt = 0;
  let lastStepAt = 0;
  let lastTurnStart = 0;
  let activeMs = 0;
  let lastStepType = '';
  let lastStepStatus = '';
  let lastToolSummary = '';
  let lastThinkingHeading = '';
  let pendingSubagentDefs = [];
  const subagents = new Map(); // convId -> info

  for (const line of lines) {
    if (!line.trim()) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = step.created_at ? Date.parse(step.created_at) : 0;
    if (ts && !startedAt) startedAt = ts;
    if (ts) lastStepAt = ts;
    lastStepType = step.type || '';
    lastStepStatus = step.status || '';

    if (step.type === 'USER_INPUT') {
      const content = String(step.content || '');
      const m = content.match(/Model Selection`?\s+from\s+[^\n]+?\s+to\s+([^.\n]+)/i);
      if (m?.[1]) model = m[1].trim();
      if (ts) lastTurnStart = ts;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      steps += 1;
      const inp = Number(step.input_tokens) || 0;
      const cache = Number(step.cache_read_tokens) || 0;
      const out = Number(step.output_tokens) || 0;
      inputTokens += inp;
      cacheReadTokens += cache;
      outputTokens += out;
      if (inp + cache + out > 0) latestCtx = inp + cache + out;

      if (typeof step.thinking === 'string' && step.thinking.trim()) {
        const heading = step.thinking.trim().split('\n').find((l) => l.trim().startsWith('**'));
        if (heading) lastThinkingHeading = heading.replace(/\*\*/g, '').trim().slice(0, 48);
      }

      const tcs = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (tcs.length) {
        lastToolSummary = summarizeToolCall(tcs[tcs.length - 1]);
        for (const tc of tcs) {
          if (tc.name === 'invoke_subagent') {
            pendingSubagentDefs.push(...parseSubagentArgs(tc.args).map((d) => ({ ...d, spawnedAt: ts })));
          }
        }
      } else if (lastTurnStart && ts >= lastTurnStart) {
        activeMs += ts - lastTurnStart;
        lastTurnStart = 0;
      }
    }

    if (step.type === 'GENERIC' && typeof step.content === 'string') {
      const matches = [...step.content.matchAll(/"conversationId"\s*:\s*"([0-9a-f-]{8,})"/gi)];
      if (matches.length) {
        for (let i = 0; i < matches.length; i++) {
          const cid = matches[i][1];
          const def = pendingSubagentDefs.shift() || {};
          if (!subagents.has(cid)) {
            subagents.set(cid, {
              conversationId: cid,
              role: def.Role || def.TypeName || 'Subagent',
              typeName: def.TypeName || 'subagent',
              modelHint: def.Model || 'inherit',
              spawnedAt: def.spawnedAt || ts,
              completedAt: 0,
              hasReply: false,
            });
          }
        }
      }
    }

    if (step.type === 'SYSTEM_MESSAGE' && typeof step.content === 'string') {
      const m = step.content.match(/sender=([0-9a-f-]{8,})/i);
      if (m?.[1] && subagents.has(m[1])) {
        const sub = subagents.get(m[1]);
        sub.hasReply = true;
        sub.completedAt = ts || sub.completedAt;
      }
    }
  }

  const totalInput = inputTokens + cacheReadTokens;
  const cacheHitPct = totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 100) : 0;

  return {
    model,
    steps,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
    latestCtx,
    cacheHitPct,
    startedAt,
    lastStepAt,
    inTurnSince: lastTurnStart,
    activeMs,
    lastStepType,
    lastStepStatus,
    activity: lastToolSummary || lastThinkingHeading || 'Thinking',
    subagents: [...subagents.values()],
  };
}

function rolePersonaFromText(text) {
  const s = String(text || '').toLowerCase();
  if (/coordinator|captain|main/.test(s)) return 'main';
  if (/architect|plan|design|shape/.test(s)) return 'architect';
  if (/develop|build|code|edit|fix|implement/.test(s)) return 'developer';
  if (/review|audit|qa|verify|check|test/.test(s)) return 'reviewer';
  if (/browser|ui|page|preview/.test(s)) return 'browser';
  if (/ship|deploy|release|commit/.test(s)) return 'shipper';
  if (/scout|research|explore|search|find/.test(s)) return 'scout';
  return 'developer';
}

function buildPanelSnapshot(appDirs, convId, userStatus, trajectoriesResp, now) {
  const trajectories = trajectoriesResp?.trajectorySummaries || {};
  const quota = buildQuotaSnapshot(userStatus, now);
  if (quota) {
    quota.weekly = buildWeeklyQuotaView(appDirs, quota, now);
  }

  const mainTranscriptPath = findTranscriptPath(appDirs, convId);
  const mainParsed = mainTranscriptPath ? readTranscriptCached(mainTranscriptPath) : null;
  const mainTraj = convId ? trajectories[convId] : null;
  const mainRunning =
    mainTraj?.status === 'CASCADE_RUN_STATUS_RUNNING' || Boolean(mainParsed?.inTurnSince);

  const mainModel = mainParsed?.model || 'Gemini 4 Hydrogen (High)';
  const ctxWindow = modelWindow(mainModel);
  const mainCtx = mainParsed?.latestCtx || 0;
  const mainDurationMs =
    (mainParsed?.activeMs || 0) +
    (mainRunning && mainParsed?.inTurnSince ? Math.max(0, now - mainParsed.inTurnSince) : 0);

  const agents = [];
  if (convId && (mainParsed || mainTraj)) {
    agents.push({
      id: convId,
      kind: 'main',
      title: mainTraj?.summary || 'Main Agent',
      persona: 'main',
      model: mainModel,
      status: mainRunning ? 'working' : 'waiting',
      activity: mainRunning ? mainParsed?.activity || 'Thinking' : 'Ready for prompt',
      steps: mainParsed?.steps || mainTraj?.stepCount || 0,
      tokens: mainParsed?.totalTokens || 0,
      ctxTokens: mainCtx,
      ctxWindow,
      ctxPct: Math.min(100, Math.round((mainCtx / ctxWindow) * 100)),
      cacheHitPct: mainParsed?.cacheHitPct || 0,
      durationMs: mainDurationMs,
    });
  }

  const knownIds = new Set(convId ? [convId] : []);

  // Subagents spawned via invoke_subagent in this conversation
  for (const sub of mainParsed?.subagents || []) {
    if (!sub.conversationId || knownIds.has(sub.conversationId)) continue;
    knownIds.add(sub.conversationId);
    const subPath = findTranscriptPath(appDirs, sub.conversationId);
    const subParsed = subPath ? readTranscriptCached(subPath) : null;
    const subTraj = trajectories[sub.conversationId];
    const isRunning = subTraj?.status === 'CASCADE_RUN_STATUS_RUNNING' && !sub.hasReply;
    const subModel =
      subParsed?.model ||
      (sub.modelHint && sub.modelHint !== 'inherit' ? sub.modelHint : mainModel);
    const win = modelWindow(subModel);
    const ctx = subParsed?.latestCtx || 0;
    const endAt = isRunning ? now : sub.completedAt || subParsed?.lastStepAt || sub.spawnedAt || now;
    agents.push({
      id: sub.conversationId,
      kind: 'subagent',
      title: sub.role || sub.typeName,
      persona: rolePersonaFromText(`${sub.role} ${sub.typeName}`),
      model: subModel,
      status: isRunning ? 'working' : 'done',
      activity: isRunning ? subParsed?.activity || 'Working' : 'Finished',
      steps: subParsed?.steps || subTraj?.stepCount || 0,
      tokens: subParsed?.totalTokens || 0,
      ctxTokens: ctx,
      ctxWindow: win,
      ctxPct: Math.min(100, Math.round((ctx / win) * 100)),
      cacheHitPct: subParsed?.cacheHitPct || 0,
      durationMs: Math.max(0, endAt - (sub.spawnedAt || subParsed?.startedAt || endAt)),
    });
  }

  // Native swarm workers if a swarm is active in this conversation
  const membersPath = findSwarmMembersPath(appDirs, convId);
  if (membersPath) {
    try {
      const roster = JSON.parse(readFileSync(membersPath, 'utf-8'));
      for (const [name, m] of Object.entries(roster?.members || {})) {
        if (!m?.conversation_id || knownIds.has(m.conversation_id) || m.killed) continue;
        knownIds.add(m.conversation_id);
        const mPath = findTranscriptPath(appDirs, m.conversation_id);
        const mParsed = mPath ? readTranscriptCached(mPath) : null;
        const mTraj = trajectories[m.conversation_id];
        const isRunning = mTraj?.status === 'CASCADE_RUN_STATUS_RUNNING';
        const mModel = m.model || mParsed?.model || mainModel;
        const win = modelWindow(mModel);
        const ctx = mParsed?.latestCtx || 0;
        agents.push({
          id: m.conversation_id,
          kind: 'swarm',
          title: `${name}${m.role ? ` (${m.role})` : ''}`,
          persona: rolePersonaFromText(`${name} ${m.role}`),
          model: mModel,
          status: isRunning ? 'working' : 'waiting',
          activity: isRunning ? mParsed?.activity || 'Working' : 'Waiting on board',
          steps: mParsed?.steps || mTraj?.stepCount || 0,
          tokens: mParsed?.totalTokens || 0,
          ctxTokens: ctx,
          ctxWindow: win,
          ctxPct: Math.min(100, Math.round((ctx / win) * 100)),
          cacheHitPct: mParsed?.cacheHitPct || 0,
          durationMs: mParsed?.activeMs || 0,
        });
      }
    } catch {
      // Ignore unreadable swarm roster.
    }
  }

  // Other currently running top-level conversations on this machine
  const otherRunning = [];
  for (const [id, t] of Object.entries(trajectories)) {
    if (knownIds.has(id)) continue;
    if (t.status === 'CASCADE_RUN_STATUS_RUNNING') {
      otherRunning.push({
        id,
        title: t.summary || 'Active conversation',
        steps: t.stepCount || 0,
        lastModifiedTime: t.lastModifiedTime || null,
      });
    }
  }

  const totalTokens = agents.reduce((s, a) => s + (a.tokens || 0), 0);
  const totalSteps = agents.reduce((s, a) => s + (a.steps || 0), 0);
  const activeCount = agents.filter((a) => a.status === 'working').length;

  return {
    now,
    conversationId: convId || null,
    summary: {
      activeCount,
      totalAgents: agents.length,
      totalTokens,
      totalSteps,
      durationMs: mainDurationMs,
    },
    agents,
    otherRunning,
    quota,
  };
}

function pickActiveConversation(trajectoriesResp) {
  const summaries = trajectoriesResp?.trajectorySummaries || {};
  const entries = Object.entries(summaries).filter(([, t]) => t && typeof t === 'object');
  if (!entries.length) return '';
  entries.sort((a, b) => {
    const aRun = a[1].status === 'CASCADE_RUN_STATUS_RUNNING' ? 1 : 0;
    const bRun = b[1].status === 'CASCADE_RUN_STATUS_RUNNING' ? 1 : 0;
    if (aRun !== bRun) return bRun - aRun;
    return (Date.parse(b[1].lastModifiedTime || '') || 0) - (Date.parse(a[1].lastModifiedTime || '') || 0);
  });
  return entries[0][0];
}

// ---------------------------------------------------------------------------
// Server bootstrap (Antigravity SidecarApp or standalone HTTP fallback)
// ---------------------------------------------------------------------------

async function start() {
  let SidecarApp = null;
  let ResponseCtor = null;
  if (!process.env.AGENT_PANEL_STANDALONE) {
    try {
      const sdk = await import('sidecar_sdk');
      SidecarApp = sdk.SidecarApp;
      ResponseCtor = sdk.Response;
    } catch {
      // Standalone mode outside Antigravity loader.
    }
  }

  const handlePanel = async (query) => {
    const now = Date.now();
    const appDirs = findAllAppDataDirs();
    const ls = discoverLanguageServer(appDirs);
    const [userStatus, trajectoriesResp] = await Promise.all([
      callLsRpc(ls, 'GetUserStatus', {}, 8000),
      callLsRpc(ls, 'GetAllCascadeTrajectories', {}, 1500),
    ]);
    const conv =
      query.conversationId ||
      process.env.ANTIGRAVITY_CONVERSATION_ID ||
      pickActiveConversation(trajectoriesResp);
    return buildPanelSnapshot(appDirs, conv, userStatus, trajectoriesResp, now);
  };

  if (SidecarApp && ResponseCtor) {
    const app = new SidecarApp();
    app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
    app.page('/hud', () => readFileSync(join(__dirname, 'hud.html'), 'utf-8'));
    for (const [route, [file, type]] of Object.entries(STATIC)) {
      app.api(route, () => new ResponseCtor(readFileSync(join(__dirname, file), 'utf-8'), { contentType: type }), 'GET');
    }
    app.api('/api/panel', async (data) => {
      const conv = data.conversationId || app.config?.conversationId || '';
      return handlePanel({ ...data, conversationId: conv });
    }, 'GET');
    app.run();
    return;
  }

  const port = Number(process.env.PORT || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 47812);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'index.html'), 'utf-8'));
      return;
    }
    if (url.pathname === '/hud' || url.pathname === '/hud.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'hud.html'), 'utf-8'));
      return;
    }
    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'Content-Type': type });
      res.end(readFileSync(join(__dirname, file), 'utf-8'));
      return;
    }
    if (url.pathname === '/api/panel') {
      const payload = await handlePanel({
        conversationId: url.searchParams.get('conversationId') || '',
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[agent_panel] standalone server listening on http://127.0.0.1:${port}`);
  });
}

start();
