// SP3-inspired attention-weighted session ranker.
// Scores existing session contexts alongside a synthetic `none` option (start new session),
// combining lexical/file/project/message signals with recency decay and voice-interaction priors.

export const DEFAULT_WEIGHTS = Object.freeze({
  titleMatch: 3.2,
  projectMatch: 2.8,
  fileMatch: 3.6,
  messageOverlap: 2.2,
  typed0: 1.4,
  typed1: 0.7,
  typed2: 0.35,
  typedAgeDecay: 0.03,
  spokeRecent: 1.6,
  waitingBonus: 1.15,
  noneBias: 0.85,
  noneNewish: 2.5,
  noneWords: 0.06,
});

const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'get', 'got', 'had', 'has',
  'have', 'hey', 'hi', 'here', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'let', 'lets', 'make', 'me', 'my', 'need', 'now', 'of', 'ok', 'okay',
  'on', 'or', 'our', 'out', 'please', 'should', 'so', 'some', 'still', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to',
  'up', 'us', 'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'would', 'you', 'your',
  // Voice/app meta words that shouldn't bias routing by themselves.
  'claude', 'orbit', 'session', 'thread', 'tell', 'ask', 'switch', 'open', 'check',
]);

const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml', 'csv', 'sql', 'graphql', 'gql', 'prisma',
  'md', 'mdx', 'txt', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'vue', 'svelte', 'astro',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'lock', 'proto', 'tf',
]);

const SPECIAL_FILES = new Set([
  'dockerfile', 'makefile', 'gemfile', 'rakefile', 'procfile', 'jenkinsfile',
  'cmakelists.txt', 'package.json', 'tsconfig.json', 'cargo.toml', 'go.mod', 'go.sum', 'pyproject.toml',
]);

const RUNTIME_NAMES = new Set(['node.js', 'next.js', 'nuxt.js', 'vue.js', 'react.js', 'three.js', 'express.js', 'nest.js', 'bun.js', 'deno.js']);

function safeText(text, maxLen = 8000) {
  if (typeof text !== 'string') return '';
  return text.slice(0, maxLen).trim();
}

/**
 * Splits camelCase, snake_case, kebab-case, and paths into lowercase tokens.
 */
export function tokenize(text, { keepStopwords = false } = {}) {
  const s = safeText(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  const raw = s.match(/[a-z0-9]+/g) || [];
  const out = [];
  for (const tok of raw) {
    if (tok.length < 2 && !/^\d$/.test(tok)) continue;
    if (!keepStopwords && STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

function normalizePhrase(text) {
  return safeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function basenameOf(p) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function stemOf(p) {
  const base = basenameOf(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Extracts mentioned file paths and filenames from a spoken or typed query.
 */
export function extractMentionedFiles(text) {
  const s = safeText(text);
  if (!s) return [];

  // Strip URLs before scanning so domains/paths in URLs aren't treated as local files.
  const withoutUrls = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  const found = [];
  const seen = new Set();

  const add = (candidate) => {
    const clean = candidate
      .replace(/^['"`(\[{<]+/, '')
      .replace(/['"`)\]}>.,;!?]+$/, '')
      .replace(/:\d+(?::\d+)?$/, '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    if (!clean || clean.length > 260) return;
    const lower = clean.toLowerCase();
    if (RUNTIME_NAMES.has(lower)) return;
    if (seen.has(lower)) return;
    seen.add(lower);
    found.push(clean);
  };

  // 1. Explicit slash paths with extension or concrete segments (e.g., src/router/ranker.js, api/auth.ts).
  const pathRe = /(?:^|[\s'"`(\[{])((?:\.{1,2}[\\/])?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+(?::\d+(?::\d+)?)?)/g;
  let m;
  while ((m = pathRe.exec(withoutUrls)) !== null) {
    const cand = m[1].replace(/[.,;!?'"`)\]}>]+$/, '');
    const base = basenameOf(cand).toLowerCase();
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot + 1) : '';
    if (ext && CODE_EXTENSIONS.has(ext)) {
      add(cand);
    } else if (SPECIAL_FILES.has(base) || base.startsWith('.env')) {
      add(cand);
    } else if (/^[a-z0-9._-]{2,}$/.test(base) && !/^(text|application|image|audio|video)\//i.test(cand)) {
      // Only accept extensionless slash paths when they look like code dirs (e.g. src/foo, test/bar).
      if (/^(src|lib|app|apps|packages|pkg|test|tests|spec|scripts|docs|config|ui|web|api|server|client|components|routes|router|pages|public|assets)\//i.test(cand.replace(/\\/g, '/').replace(/^\.\//, ''))) {
        add(cand);
      }
    }
  }

  // 2. Standalone filenames with known extensions (e.g. billing.ts, package.json, .env.local).
  const fileRe = /(?:^|[\s'"`(\[{])((?:\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\.([A-Za-z0-9]{1,10}))(?=$|[\s'"`)\]}>.,;:!?])/g;
  while ((m = fileRe.exec(withoutUrls)) !== null) {
    const full = m[1];
    const ext = m[2].toLowerCase();
    if (/^v?\d+(?:\.\d+)+$/i.test(full)) continue;
    if (full.toLowerCase().startsWith('.env')) {
      add(full);
      continue;
    }
    if (CODE_EXTENSIONS.has(ext)) {
      add(full);
    }
  }

  // 3. Special extensionless filenames (Dockerfile, Makefile, etc.).
  const specialRe = /\b(Dockerfile|Makefile|Gemfile|Rakefile|Procfile|Jenkinsfile)\b/g;
  while ((m = specialRe.exec(withoutUrls)) !== null) {
    add(m[1]);
  }

  // 4. Spoken file names like "server dot js" or "package dot json".
  const spokenRe = /\b([A-Za-z][A-Za-z0-9_-]{1,40})\s+dot\s+([A-Za-z0-9]{2,8})\b/gi;
  while ((m = spokenRe.exec(withoutUrls)) !== null) {
    const ext = m[2].toLowerCase();
    if (CODE_EXTENSIONS.has(ext)) {
      add(`${m[1].toLowerCase()}.${ext}`);
    }
  }

  return found;
}

const NEW_WORK_PATTERNS = [
  /\b(?:start|begin|open|create|spin up|kick off|launch|make)\s+(?:a\s+)?(?:brand\s+)?(?:new|fresh|separate)\s+(?:session|thread|task|project|repo|repository|app|application|service|tool|cli|script|package|site|website|dashboard|feature|topic|conversation|workspace)\b/i,
  /\b(?:new|fresh|separate)\s+(?:session|thread|project|topic|conversation|workspace)\b/i,
  /\b(?:from scratch|start fresh|start over|brand new (?:project|app|service|tool|cli|repo|feature|site)|completely different|something (?:completely )?(?:new|different|unrelated)|unrelated (?:task|question|topic|project|work)|different (?:topic|project|task)|switch gears|off topic|on (?:a |an )?(?:separate|different|unrelated|another) note)\b/i,
  /\b(?:scaffold|bootstrap|initialize|init)\s+(?:a\s+)?(?:new\s+)?(?:project|app|application|service|repo|repository|cli|package|site|website|server|api|dashboard)\b/i,
  /\b(?:let'?s|i want to|can we|please)\s+build\s+a\s+(?:new\s+|brand new\s+)?[a-z0-9_-]+(?:\s+[a-z0-9_-]+){0,4}\s+(?:app|application|cli|tool|service|bot|dashboard|website|site|tracker|scraper|extension|server|project)\b/i,
];

/**
 * Returns true if the utterance strongly signals brand-new, separate work
 * rather than continuing an existing session.
 */
export function looksLikeNewWork(text) {
  const s = safeText(text);
  if (!s) return false;
  return NEW_WORK_PATTERNS.some((re) => re.test(s));
}

const BARE_FOLLOW_UP_PATTERNS = [
  /^(?:yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|alright|right|correct|exactly|agreed|confirmed|affirmative|negative)[!.?]*$/i,
  /^(?:ok(?:ay)?|yeah|yes|sure|alright)?[,\s]*(?:go ahead|do it|do that|proceed|continue|keep going|carry on|run it|run that|try again|retry|retry it|ship it|send it|commit it|commit that|push it|push that|revert it|revert that|undo it|undo that|fix it|fix that|looks good|sounds good|lgtm|approve(?: it)?|allow(?: it| once| always)?|deny(?: it)?|reject(?: it)?|skip(?: it)?|cancel(?: it| that)?|never ?mind|stop|wait|hold on)[!.?]*$/i,
  /^(?:go with |pick |choose |use |select )?(?:option\s+(?:one|two|three|four|five|\d+)|(?:the\s+)?(?:first|second|third|fourth|last)\s+one)[!.?]*$/i,
  /^(?:why|how come|what happened|what did (?:it|that|claude) say|did (?:it|that) (?:work|pass|fail)|any errors|is it (?:done|ready|passing|working)|show me|tell me more|explain (?:it|that)|more details|what'?s next|same(?: thing)?|do the same|one more thing)[!.?]*$/i,
  /^(?:now|also|and|and also|then|next)[,\s]+(?:run|check|fix|add|update|push|commit|test|build|lint|format|rerun|try)\b/i,
  /^(?:run|rerun|check)\s+(?:the\s+)?(?:tests?|build|lint(?:er)?|logs?|status|diff)[!.?]*$/i,
];

/**
 * Returns true if the utterance is a short, context-dependent follow-up
 * without explicit file targets or new-work signals.
 */
export function isBareFollowUp(text) {
  const s = safeText(text);
  if (!s) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 10) return false;
  if (looksLikeNewWork(s)) return false;
  if (extractMentionedFiles(s).length > 0) return false;
  return BARE_FOLLOW_UP_PATTERNS.some((re) => re.test(s));
}

function tokenMatch(a, b) {
  if (a === b) return 1;
  // Simple plural/prefix match for technical terms >= 4 chars (e.g. test/tests, route/routing, auth/authentication).
  if (a.length >= 4 && b.length >= 4) {
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (longer.startsWith(shorter) && shorter.length / longer.length >= 0.6) return 0.75;
  }
  return 0;
}

function tokenOverlapScore(queryTokens, targetTokens) {
  if (!queryTokens.length || !targetTokens.length) return 0;
  let queryHits = 0;
  for (const qt of queryTokens) {
    let best = 0;
    for (const tt of targetTokens) {
      const m = tokenMatch(qt, tt);
      if (m > best) best = m;
      if (best === 1) break;
    }
    queryHits += best;
  }
  let targetHits = 0;
  for (const tt of targetTokens) {
    let best = 0;
    for (const qt of queryTokens) {
      const m = tokenMatch(tt, qt);
      if (m > best) best = m;
      if (best === 1) break;
    }
    targetHits += best;
  }
  const qRecall = queryHits / queryTokens.length;
  const tRecall = targetHits / targetTokens.length;
  // Blend query coverage and target coverage so concise targeted mentions score well.
  return Math.min(1, 0.55 * tRecall + 0.45 * qRecall);
}

function scoreTitleMatch(queryPhrase, queryTokens, ctx) {
  const rawTitle = safeText(ctx?.title);
  if (!rawTitle || rawTitle === '(untitled)') return 0;
  const titlePhrase = normalizePhrase(rawTitle);
  if (!titlePhrase) return 0;

  if (titlePhrase.length >= 3 && queryPhrase.includes(titlePhrase)) return 1;

  const titleTokens = tokenize(rawTitle);
  let score = tokenOverlapScore(queryTokens, titleTokens);

  // Branch name is closely related to task title (e.g. feat/stripe-webhooks).
  if (ctx?.branch) {
    const branchTokens = tokenize(ctx.branch).filter((t) => !['feat', 'fix', 'chore', 'main', 'master', 'dev', 'branch'].includes(t));
    if (branchTokens.length) {
      const bScore = tokenOverlapScore(queryTokens, branchTokens) * 0.85;
      if (bScore > score) score = bScore;
    }
  }
  return Math.min(1, score);
}

function scoreProjectMatch(queryPhrase, queryTokens, ctx) {
  const rawProject = safeText(ctx?.project);
  if (!rawProject || rawProject === '(no folder)') return 0;
  const projPhrase = normalizePhrase(rawProject);
  if (!projPhrase || projPhrase.length < 2) return 0;

  // Whole-word phrase match of project name in query.
  const paddedQuery = ` ${queryPhrase} `;
  if (paddedQuery.includes(` ${projPhrase} `)) return 1;

  // Compact match (e.g. "orbitvoice" vs "orbit-voice").
  const compactProj = projPhrase.replace(/\s+/g, '');
  const compactQuery = queryPhrase.replace(/\s+/g, '');
  if (compactProj.length >= 4 && compactQuery.includes(compactProj)) return 0.95;

  const projTokens = tokenize(rawProject);
  if (!projTokens.length) return 0;
  // Require strong overlap on distinctive project tokens.
  let matched = 0;
  for (const pt of projTokens) {
    let best = 0;
    for (const qt of queryTokens) {
      const m = tokenMatch(pt, qt);
      if (m > best) best = m;
    }
    matched += best;
  }
  const ratio = matched / projTokens.length;
  return ratio >= 0.5 ? Math.min(1, ratio * 0.9) : 0;
}

function scoreFileMatch(mentionedFiles, queryTokens, ctx) {
  const recentFiles = Array.isArray(ctx?.recentFiles) ? ctx.recentFiles.filter((f) => typeof f === 'string' && f.trim()) : [];
  if (!recentFiles.length) return 0;

  const normRecent = recentFiles.map((f) => {
    const norm = f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    return {
      norm,
      base: basenameOf(norm),
      stem: stemOf(norm),
    };
  });

  if (mentionedFiles.length > 0) {
    let bestScore = 0;
    let totalScore = 0;
    for (const mf of mentionedFiles) {
      const mNorm = mf.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
      const mBase = basenameOf(mNorm);
      const mStem = stemOf(mNorm);
      let fileBest = 0;
      for (const rf of normRecent) {
        if (rf.norm === mNorm || rf.norm.endsWith(`/${mNorm}`) || mNorm.endsWith(`/${rf.norm}`)) {
          fileBest = Math.max(fileBest, 1.0);
        } else if (rf.base === mBase && mBase.length >= 3) {
          fileBest = Math.max(fileBest, 0.92);
        } else if (rf.stem === mStem && mStem.length >= 4) {
          fileBest = Math.max(fileBest, 0.65);
        }
      }
      bestScore = Math.max(bestScore, fileBest);
      totalScore += fileBest;
    }
    const avg = totalScore / mentionedFiles.length;
    return Math.min(1, 0.7 * bestScore + 0.3 * avg);
  }

  // No explicit file with extension in query: allow modest boost if a distinctive file stem (>= 5 chars) appears in query tokens.
  if (!queryTokens.length) return 0;
  let stemScore = 0;
  const genericStems = new Set(['index', 'utils', 'helper', 'helpers', 'types', 'config', 'server', 'client', 'tests', 'styles', 'readme', 'manager', 'service', 'handler', 'controller', 'store', 'model', 'module']);
  for (const rf of normRecent) {
    if (rf.stem.length < 5 || genericStems.has(rf.stem)) continue;
    const stemTokens = tokenize(rf.stem);
    if (!stemTokens.length) continue;
    const allPresent = stemTokens.every((st) => queryTokens.some((qt) => tokenMatch(st, qt) >= 0.75));
    if (allPresent) {
      stemScore = Math.max(stemScore, 0.45);
    } else {
      const distinctiveHit = stemTokens.some(
        (st) => st.length >= 6 && !genericStems.has(st) && queryTokens.some((qt) => tokenMatch(st, qt) >= 0.85),
      );
      if (distinctiveHit) stemScore = Math.max(stemScore, 0.3);
    }
  }
  return stemScore;
}

const COMMIT_NOISE_TOKENS = new Set(['feat', 'fix', 'chore', 'refactor', 'style', 'docs', 'ci', 'perf', 'add', 'update', 'remove', 'change', 'also']);

function tokenSpecificity(tok) {
  if (COMMIT_NOISE_TOKENS.has(tok)) return 0.25;
  if (tok.length >= 7) return 1.4;
  if (tok.length >= 5) return 1.15;
  return 0.75;
}

function scoreMessageOverlap(queryTokens, ctx) {
  if (!queryTokens.length) return 0;
  const sources = [];
  if (Array.isArray(ctx?.lastMessages)) {
    for (const m of ctx.lastMessages) if (typeof m === 'string' && m.trim()) sources.push(m);
  }
  if (Array.isArray(ctx?.recentCommits)) {
    for (const c of ctx.recentCommits) if (typeof c === 'string' && c.trim()) sources.push(c);
  }
  if (!sources.length) return 0;

  const targetTokens = new Set();
  for (const src of sources) {
    for (const tok of tokenize(src)) targetTokens.add(tok);
  }
  if (!targetTokens.size) return 0;

  const targetArr = [...targetTokens];
  let weightedHits = 0;
  let totalWeight = 0;
  for (const qt of queryTokens) {
    const w = tokenSpecificity(qt);
    totalWeight += w;
    let best = 0;
    for (const tt of targetArr) {
      const m = tokenMatch(qt, tt);
      if (m > best) best = m;
      if (best === 1) break;
    }
    weightedHits += best * w;
  }

  // Reward both weighted recall over query tokens and absolute distinctive term hits.
  const recall = totalWeight > 0 ? weightedHits / totalWeight : 0;
  const absFactor = Math.min(1, weightedHits / 3);
  return Math.min(1, 0.65 * recall + 0.35 * absFactor);
}

function resolveWeights(overrides) {
  if (!overrides || typeof overrides !== 'object') return DEFAULT_WEIGHTS;
  const w = { ...DEFAULT_WEIGHTS };
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    if (typeof overrides[key] === 'number' && Number.isFinite(overrides[key])) {
      w[key] = overrides[key];
    }
  }
  return w;
}

function computeRecencyRanks(contexts, activeId, recentInteractedIds) {
  const ranks = new Map();

  if (Array.isArray(recentInteractedIds) && recentInteractedIds.length > 0) {
    const ordered = [];
    const seen = new Set();
    const push = (id) => {
      if (typeof id !== 'string' || !id || seen.has(id)) return;
      seen.add(id);
      ordered.push(id);
    };
    if (activeId && !recentInteractedIds.includes(activeId)) push(activeId);
    for (const id of recentInteractedIds) push(id);
    for (let i = 0; i < ordered.length; i++) ranks.set(ordered[i], i);
    return ranks;
  }

  // No explicit interaction order: assign activeId rank 0 (if given) and rank remaining
  // sessions by timestamp descending, giving tied timestamps the SAME rank so array order
  // never fabricates a false winner.
  let nextRank = 0;
  if (activeId) {
    ranks.set(activeId, 0);
    nextRank = 1;
  }

  const remaining = contexts
    .filter((c) => c.id && !ranks.has(c.id))
    .map((c) => ({
      id: c.id,
      ts: Math.max(Number(c.lastFocusedAt) || 0, Number(c.lastActivityAt) || 0),
    }))
    .sort((a, b) => b.ts - a.ts);

  let prevTs = null;
  let currentRank = nextRank;
  for (let i = 0; i < remaining.length; i++) {
    const item = remaining[i];
    if (prevTs !== null && item.ts < prevTs) {
      currentRank = nextRank + i;
    }
    ranks.set(item.id, currentRank);
    prevTs = item.ts;
  }
  return ranks;
}

/**
 * Ranks session contexts + a synthetic `none` (new session) option for a spoken/typed query.
 */
export function rankCandidates(
  query,
  contexts,
  {
    activeId = null,
    lastSpokenId = null,
    lastSpokenAt = 0,
    recentInteractedIds = null,
    now = Date.now(),
    weights = null,
  } = {},
) {
  const q = safeText(query);
  const ctxList = Array.isArray(contexts) ? contexts.filter((c) => c && typeof c === 'object') : [];
  const w = resolveWeights(weights);
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

  if (!q) {
    const active = activeId ? ctxList.find((c) => c.id === activeId) || null : null;
    return {
      best: active,
      score: 0,
      runnerUp: null,
      margin: 0,
      confidence: active ? 1 : 0,
      ambiguous: false,
      suggestNew: !active && ctxList.length === 0,
      candidates: [],
      reasons: ['emptyQuery'],
    };
  }

  const queryPhrase = normalizePhrase(q);
  const queryTokens = tokenize(q);
  const mentionedFiles = extractMentionedFiles(q);
  const bareFollowUp = isBareFollowUp(q);
  const newWork = looksLikeNewWork(q);
  const wordCount = q.split(/\s+/).filter(Boolean).length;

  const recencyRanks = computeRecencyRanks(ctxList, activeId, recentInteractedIds);
  const typedWeights = [w.typed0, w.typed1, w.typed2];

  const scored = ctxList.map((ctx) => {
    const titleS = scoreTitleMatch(queryPhrase, queryTokens, ctx);
    const projectS = scoreProjectMatch(queryPhrase, queryTokens, ctx);
    const fileS = scoreFileMatch(mentionedFiles, queryTokens, ctx);
    const msgS = scoreMessageOverlap(queryTokens, ctx);

    const recIdx = recencyRanks.has(ctx.id) ? recencyRanks.get(ctx.id) : -1;
    const baseTyped = recIdx >= 0 && recIdx < typedWeights.length ? typedWeights[recIdx] : 0;
    const ts = Math.max(Number(ctx.lastFocusedAt) || 0, Number(ctx.lastActivityAt) || 0);
    const ageMin = ts > 0 && nowMs > ts ? (nowMs - ts) / 60_000 : 0;
    const ageDecay = ts > 0 ? Math.exp(-Math.max(0, w.typedAgeDecay) * ageMin) : 1;
    const typedContrib = baseTyped * ageDecay;

    let spokeContrib = 0;
    if (lastSpokenId && ctx.id === lastSpokenId) {
      const spokeTs = Number(lastSpokenAt) || 0;
      const spokeAgeMin = spokeTs > 0 && nowMs > spokeTs ? (nowMs - spokeTs) / 60_000 : 0;
      const spokeDecay = spokeTs > 0 ? Math.exp(-0.15 * spokeAgeMin) : 1;
      spokeContrib = w.spokeRecent * spokeDecay * (bareFollowUp ? 1.25 : 1);
    }

    const isWaiting = ctx.waiting === true || ctx.status === 'waiting';
    const waitingContrib = isWaiting ? w.waitingBonus * (bareFollowUp ? 1.45 : 1) : 0;

    const breakdown = {
      titleMatch: titleS * w.titleMatch,
      projectMatch: projectS * w.projectMatch,
      fileMatch: fileS * w.fileMatch,
      messageOverlap: msgS * w.messageOverlap,
      typed: typedContrib,
      spokeRecent: spokeContrib,
      waitingBonus: waitingContrib,
    };

    const score =
      breakdown.titleMatch +
      breakdown.projectMatch +
      breakdown.fileMatch +
      breakdown.messageOverlap +
      breakdown.typed +
      breakdown.spokeRecent +
      breakdown.waitingBonus;

    const reasons = [];
    if (fileS >= 0.6) reasons.push('fileMatch');
    if (projectS >= 0.5) reasons.push('projectMatch');
    if (titleS >= 0.4) reasons.push('titleMatch');
    if (msgS >= 0.35) reasons.push('messageOverlap');
    if (ctx.id === activeId) reasons.push('activeSession');
    else if (recIdx >= 0 && recIdx < 3 && typedContrib >= 0.25) reasons.push(`recentSession_${recIdx}`);
    if (spokeContrib >= 0.4) reasons.push('recentlySpoken');
    if (waitingContrib > 0) reasons.push('waitingForInput');
    if (bareFollowUp && score > 0) reasons.push('bareFollowUp');

    return {
      id: ctx.id,
      isNone: false,
      context: ctx,
      score,
      probability: 0,
      breakdown,
      reasons,
    };
  });

  // Synthetic `none` candidate ("no existing session fits / start new session").
  const wordsTerm = bareFollowUp ? 0 : Math.min(wordCount, 25) * w.noneWords;
  const newishTerm = newWork ? w.noneNewish : 0;
  const rawNoneScore = w.noneBias + newishTerm + wordsTerm;
  const noneScore = bareFollowUp && ctxList.length > 0 ? rawNoneScore * 0.25 : rawNoneScore;

  const noneReasons = [];
  if (newWork) noneReasons.push('newWorkSignal');
  if (wordsTerm >= 0.5) noneReasons.push('selfContainedPrompt');
  if (!ctxList.length) noneReasons.push('noSessions');
  if (!noneReasons.length) noneReasons.push('noneBaseline');

  const noneCandidate = {
    id: 'none',
    isNone: true,
    context: null,
    score: noneScore,
    probability: 0,
    breakdown: {
      noneBias: bareFollowUp && ctxList.length > 0 ? w.noneBias * 0.25 : w.noneBias,
      noneNewish: newishTerm,
      noneWords: wordsTerm,
    },
    reasons: noneReasons,
  };

  const all = [...scored, noneCandidate];
  all.sort((a, b) => b.score - a.score);

  // Softmax probabilities across all candidates including `none`.
  const maxScore = all[0].score;
  let expSum = 0;
  const exps = all.map((c) => {
    const e = Math.exp(c.score - maxScore);
    expSum += e;
    return e;
  });
  for (let i = 0; i < all.length; i++) {
    all[i].probability = expSum > 0 ? exps[i] / expSum : 0;
  }

  const top = all[0];
  const second = all[1] || null;
  const margin = second ? top.score - second.score : top.score;
  const confidence = Number(top.probability.toFixed(4));
  const suggestNew = top.isNone;

  // Runner-up is the best non-top session (or null if none exists).
  const runnerUpCandidate = second && !second.isNone
    ? second
    : all.find((c, idx) => idx > 0 && !c.isNone) || null;

  // Ambiguous when top choice doesn't cleanly separate from the second choice.
  const ambiguous = Boolean(
    second &&
      ((!suggestNew && (margin < 0.65 || (confidence < 0.52 && margin < 0.85))) ||
        (suggestNew && ctxList.length > 0 && margin < 0.45)),
  );

  return {
    best: top.isNone ? null : top.context,
    score: Number(top.score.toFixed(4)),
    runnerUp: runnerUpCandidate ? runnerUpCandidate.context : null,
    margin: Number(margin.toFixed(4)),
    confidence,
    ambiguous,
    suggestNew,
    candidates: all.map((c) => ({
      ...c,
      score: Number(c.score.toFixed(4)),
      probability: Number(c.probability.toFixed(4)),
    })),
    reasons: top.reasons,
  };
}
