// Demo server for the README media. Serves the real panel and HUD from
// sidecars/agent_panel, but answers /api/panel from scripted fixtures instead
// of a live Antigravity session, so screenshots show no private chat titles.
// GET /__stage?name=<stage> switches the fixture. Pages in ./pages are served at /pages/.
// Run: node assets/src/serve.mjs   (port 47900)
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '../../sidecars/agent_panel');
const assets = join(here, '..');
const PORT = Number(process.env.PORT || 47900);
const H = 3600e3;

const agent = (id, persona, model, status, title, activity, tokens, ctxPct, mins) => ({
  id, kind: id === 'main' ? 'main' : 'subagent', title, persona, model, status, activity,
  steps: Math.round(tokens / 18000) + 3, tokens, ctxTokens: ctxPct * 10000, ctxWindow: 1000000,
  ctxPct, cacheHitPct: 81, durationMs: mins * 60e3,
});

const pool = (name, label, usedPct, elapsedPct, leftH, models, weeklyUsed, weeklyElapsed) => {
  const verdict = (u, e) => {
    if (u < 0.2) return 'fresh';
    const p = u / Math.max(e, 1);
    return p > 1.15 ? 'over pace' : p > 1 ? 'ahead of pace' : p < 0.85 ? 'under pace' : 'on pace';
  };
  const weekly = {
    windowLabel: '7d', usedPct: weeklyUsed, remainingPct: 100 - weeklyUsed, elapsedPct: weeklyElapsed,
    pace: weeklyUsed / Math.max(weeklyElapsed, 1), verdict: verdict(weeklyUsed, weeklyElapsed),
    leftMs: (100 - weeklyElapsed) * 1.68 * H, models,
  };
  const own = label === '7d' ? weekly : {
    windowLabel: label, usedPct, remainingPct: 100 - usedPct, elapsedPct,
    pace: usedPct / Math.max(elapsedPct, 1), verdict: verdict(usedPct, elapsedPct), leftMs: leftH * H, models,
  };
  return { name, ...own, weekly };
};

const MAIN = 'Gemini 4 Argon';
const TASK = 'Build a recipe search page';
const quota = (h, a, c) => ({
  planName: 'Pro', promptCredits: 500, flowCredits: 100, monthlyPromptCredits: 50000, monthlyFlowCredits: 150000,
  pools: [
    pool('Hydrogen / Flash', '5h', h, 46, 2.7, ['Hydrogen', '3.8 Flash'], 41, 52),
    pool('Argon', '7d', 0, 0, 0, ['Argon'], a, 52),
    pool('Claude / OSS', '5h', c, 46, 2.7, ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'], 12, 52),
  ],
  unavailable: [],
});

const stages = {
  idle: [[agent('main', 'main', MAIN, 'waiting', TASK, 'Ready for prompt', 42000, 4, 0)], quota(22, 44, 6)],
  plan: [[
    agent('main', 'main', MAIN, 'working', TASK, 'Planning the work', 118000, 12, 2),
    agent('a1', 'architect', 'Gemini 4 Carbon', 'working', 'Plan the search page', 'Reading the recipe schema', 64000, 7, 1),
  ], quota(31, 47, 6)],
  build: [[
    agent('main', 'main', MAIN, 'working', TASK, 'Coordinating 3 agents', 236000, 24, 6),
    agent('a1', 'architect', 'Gemini 4 Carbon', 'done', 'Plan the search page', 'Plan written', 98000, 10, 3),
    agent('a2', 'developer', 'Gemini 4 Hydrogen (High)', 'working', 'Build the search filters', 'Editing filters.tsx', 154000, 16, 3),
    agent('a3', 'browser', 'Gemini 3.8 Flash', 'working', 'Check the page in a browser', 'Opening localhost:3000', 41000, 5, 1),
  ], quota(48, 51, 6)],
  review: [[
    agent('main', 'main', MAIN, 'working', TASK, 'Coordinating 2 agents', 312000, 31, 9),
    agent('a2', 'developer', 'Gemini 4 Hydrogen (High)', 'done', 'Build the search filters', 'Filters shipped', 211000, 21, 5),
    agent('a4', 'reviewer', 'Claude Sonnet', 'working', 'Review the diff', 'Reading 6 changed files', 73000, 8, 2),
    agent('a5', 'shipper', 'Gemini 3.8 Flash', 'working', 'Ship it to staging', 'Pushing the branch', 22000, 3, 1),
  ], quota(57, 53, 19)],
  done: [[
    agent('main', 'main', MAIN, 'done', TASK, 'All 5 agents finished', 388000, 38, 12),
    agent('a4', 'reviewer', 'Claude Sonnet', 'done', 'Review the diff', 'Approved', 96000, 10, 3),
    agent('a5', 'shipper', 'Gemini 3.8 Flash', 'done', 'Ship it to staging', 'Live on staging', 38000, 4, 2),
  ], quota(61, 54, 21)],
};

let current = 'build';
const snapshot = () => {
  const [agents, q] = stages[current];
  const tokens = agents.reduce((s, a) => s + a.tokens, 0);
  q.weekly = {
    trackedDays: 4, weekElapsedPct: 52, totalTokens7d: 48200000, totalChats7d: 23, promptUsedPct: 38, flowUsedPct: 41,
    pools: q.pools.map((p) => ({ ...p.weekly, name: p.name, tokens7d: p.weekly.usedPct * 410000, cycles7d: 9, source: 'native',
      note: `${p.weekly.remainingPct}% left · ${p.weekly.elapsedPct}% wk elapsed` })),
  };
  return {
    now: Date.now(), conversationId: 'main',
    summary: { activeCount: agents.filter((a) => a.status === 'working').length, totalAgents: agents.length,
      totalTokens: tokens, totalSteps: agents.reduce((s, a) => s + a.steps, 0), durationMs: agents[0].durationMs },
    agents, otherRunning: [], quota: q,
  };
};

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const file = (res, p) => {
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': `${TYPES[extname(p)] || 'text/plain'}; charset=utf-8` });
  res.end(readFileSync(p));
};

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  if (p === '/__stage') {
    current = stages[url.searchParams.get('name')] ? url.searchParams.get('name') : current;
    res.writeHead(200); return res.end(current);
  }
  if (p === '/api/panel') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(snapshot()));
  }
  if (p === '/' || p === '/index.html') return file(res, join(app, 'index.html'));
  if (p === '/hud' || p === '/hud.html') return file(res, join(app, 'hud.html'));
  if (p === '/preload.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end("document.documentElement.style.setProperty('--background','#151515');"); }
  if (p.startsWith('/pages/')) return file(res, join(here, p));
  if (p.startsWith('/crew/')) return file(res, join(assets, p));
  return file(res, join(app, p.slice(1)));
}).listen(PORT, '127.0.0.1', () => console.log(`demo server on http://127.0.0.1:${PORT}`));
