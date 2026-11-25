// Advisory topic-drift guard.
// Detects when a prompt addressed to the active session actually targets another session
// or a completely new topic. Never auto-switches: returns an advisory verdict only.

import {
  extractMentionedFiles,
  isBareFollowUp,
  looksLikeNewWork,
  tokenize,
} from './ranker.js';

export const DEFAULT_DRIFT_THRESHOLD = 0.8;

const LONG_PROMPT_WORDS = 25;
const DEFAULT_SUBJECT_TIMEOUT_MS = 2000;

function safeStr(v, maxLen = 8000) {
  return typeof v === 'string' ? v.slice(0, maxLen).trim() : '';
}

function normalizePhrase(v) {
  return safeStr(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function basenameOf(p) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function tokenMatch(a, b) {
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4) {
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (longer.startsWith(shorter) && shorter.length / longer.length >= 0.6) return 0.75;
  }
  return 0;
}

function overlapRatio(queryTokens, targetTokens) {
  if (!queryTokens.length || !targetTokens.length) return 0;
  let hits = 0;
  for (const qt of queryTokens) {
    let best = 0;
    for (const tt of targetTokens) {
      const m = tokenMatch(qt, tt);
      if (m > best) best = m;
      if (best === 1) break;
    }
    hits += best;
  }
  return hits / queryTokens.length;
}

function projectMentioned(textPhrase, textTokens, ctx) {
  const raw = safeStr(ctx?.project);
  if (!raw || raw === '(no folder)') return false;
  const projPhrase = normalizePhrase(raw);
  if (!projPhrase || projPhrase.length < 2) return false;
  if (` ${textPhrase} `.includes(` ${projPhrase} `)) return true;
  const compactProj = projPhrase.replace(/\s+/g, '');
  if (compactProj.length >= 4 && textPhrase.replace(/\s+/g, '').includes(compactProj)) return true;
  const projTokens = tokenize(raw);
  if (projTokens.length >= 2) {
    const hits = projTokens.filter((pt) => textTokens.some((tt) => tokenMatch(pt, tt) >= 0.85)).length;
    if (hits === projTokens.length) return true;
  }
  return false;
}

function filesMatchContext(mentionedFiles, ctx) {
  if (!mentionedFiles.length || !Array.isArray(ctx?.recentFiles) || !ctx.recentFiles.length) return false;
  const recent = ctx.recentFiles
    .filter((f) => typeof f === 'string' && f.trim())
    .map((f) => {
      const norm = f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
      return { norm, base: basenameOf(norm) };
    });

  for (const mf of mentionedFiles) {
    const mNorm = mf.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const mBase = basenameOf(mNorm);
    for (const rf of recent) {
      if (rf.norm === mNorm || rf.norm.endsWith(`/${mNorm}`) || mNorm.endsWith(`/${rf.norm}`)) return true;
      if (mBase.length >= 3 && rf.base === mBase) return true;
    }
  }
  return false;
}

function titleMatchStrength(textPhrase, textTokens, ctx) {
  const raw = safeStr(ctx?.title);
  if (!raw || raw === '(untitled)') return 0;
  const titlePhrase = normalizePhrase(raw);
  if (titlePhrase.length >= 4 && textPhrase.includes(titlePhrase)) return 1;
  const titleTokens = tokenize(raw);
  if (!titleTokens.length || !textTokens.length) return 0;
  const tHits = titleTokens.filter((tt) => textTokens.some((qt) => tokenMatch(tt, qt) >= 0.75)).length;
  const qHits = textTokens.filter((qt) => titleTokens.some((tt) => tokenMatch(qt, tt) >= 0.75)).length;
  return 0.6 * (tHits / titleTokens.length) + 0.4 * (qHits / textTokens.length);
}

function contextLexicalOverlap(textTokens, ctx) {
  if (!textTokens.length || !ctx) return 0;
  const bag = new Set();
  for (const field of [ctx.title, ctx.project, ctx.branch]) {
    for (const t of tokenize(field)) bag.add(t);
  }
  if (Array.isArray(ctx.recentFiles)) {
    for (const f of ctx.recentFiles) {
      for (const t of tokenize(f)) bag.add(t);
    }
  }
  if (Array.isArray(ctx.lastMessages)) {
    for (const m of ctx.lastMessages) {
      for (const t of tokenize(m)) bag.add(t);
    }
  }
  if (Array.isArray(ctx.recentCommits)) {
    for (const c of ctx.recentCommits) {
      for (const t of tokenize(c)) bag.add(t);
    }
  }
  return overlapRatio(textTokens, [...bag]);
}

async function runExtractSubject(extractSubject, prompt, meta, timeoutMs) {
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => extractSubject(prompt, meta)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('extractSubject timeout')), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    if (typeof result === 'string' && result.trim()) return result.trim();
    if (result && typeof result === 'object' && typeof result.subject === 'string' && result.subject.trim()) {
      return result.subject.trim();
    }
    return null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function buildWarning({ activeContext, suggestedSession, suggestNew }) {
  const activeTitle = safeStr(activeContext?.title) || 'the current session';
  if (suggestedSession) {
    const targetTitle = safeStr(suggestedSession.title) || 'another session';
    const targetProj = safeStr(suggestedSession.project);
    const label = targetProj ? `"${targetTitle}" (${targetProj})` : `"${targetTitle}"`;
    return `This looks like work for ${label} rather than "${activeTitle}".`;
  }
  if (suggestNew) {
    return `This sounds like a new topic unrelated to "${activeTitle}". Consider starting a new session.`;
  }
  return `This may be off-topic for "${activeTitle}".`;
}

/**
 * Advisory check for whether `prompt` has drifted away from `activeContext`.
 * Never auto-switches sessions. For prompts >= 25 words, calls optional `extractSubject`
 * (with timeout) to filter out incidental mentions of other projects/files.
 */
export async function checkTopicDrift({
  prompt,
  activeContext,
  otherContexts = [],
  threshold = DEFAULT_DRIFT_THRESHOLD,
  extractSubject = null,
  subjectTimeoutMs = DEFAULT_SUBJECT_TIMEOUT_MS,
} = {}) {
  const noDrift = {
    drifted: false,
    confidence: 0,
    reason: null,
    suggestedSession: null,
    suggestNew: false,
    warning: null,
  };

  const rawPrompt = safeStr(prompt);
  if (!rawPrompt || !activeContext || typeof activeContext !== 'object') return noDrift;
  if (isBareFollowUp(rawPrompt)) return noDrift;

  const effThreshold = Number.isFinite(threshold) ? clamp01(threshold) : DEFAULT_DRIFT_THRESHOLD;
  const others = Array.isArray(otherContexts)
    ? otherContexts.filter((c) => c && typeof c === 'object' && c.id !== activeContext.id)
    : [];

  const wordCount = rawPrompt.split(/\s+/).filter(Boolean).length;
  let subjectText = rawPrompt;
  let usedExtractedSubject = false;

  if (wordCount >= LONG_PROMPT_WORDS && typeof extractSubject === 'function') {
    const timeout = Number.isFinite(subjectTimeoutMs) && subjectTimeoutMs > 0 ? subjectTimeoutMs : DEFAULT_SUBJECT_TIMEOUT_MS;
    const extracted = await runExtractSubject(
      extractSubject,
      rawPrompt,
      { activeContext, otherContexts: others },
      timeout,
    );
    if (extracted) {
      subjectText = extracted;
      usedExtractedSubject = true;
    }
  }

  if (isBareFollowUp(subjectText)) return noDrift;

  const phrase = normalizePhrase(subjectText);
  const tokens = tokenize(subjectText);
  const mentionedFiles = extractMentionedFiles(subjectText);

  const activeProjectHit = projectMentioned(phrase, tokens, activeContext);
  const activeFileHit = filesMatchContext(mentionedFiles, activeContext);
  const activeTitleStrength = titleMatchStrength(phrase, tokens, activeContext);
  const activeOverlap = contextLexicalOverlap(tokens, activeContext);
  const anchoredToActive = activeProjectHit || activeFileHit || activeTitleStrength >= 0.45 || activeOverlap >= 0.35;

  // Evaluate each other session for explicit file, project, or strong topic match.
  let bestOther = null;
  let bestOtherConfidence = 0;
  let bestOtherReason = null;

  const activeProjNorm = normalizePhrase(activeContext.project);

  for (const other of others) {
    const otherProjNorm = normalizePhrase(other.project);
    const distinctProject = Boolean(otherProjNorm && otherProjNorm !== activeProjNorm);
    const otherFileHit = filesMatchContext(mentionedFiles, other);
    const otherProjectHit = distinctProject && projectMentioned(phrase, tokens, other);
    const otherTitleStrength = titleMatchStrength(phrase, tokens, other);
    const otherOverlap = contextLexicalOverlap(tokens, other);

    let conf = 0;
    let reason = null;

    if (otherFileHit && !activeFileHit) {
      conf = otherProjectHit || otherTitleStrength >= 0.4 ? 0.95 : 0.9;
      reason = 'other_session_file_match';
    } else if (otherProjectHit && !activeProjectHit) {
      conf = otherTitleStrength >= 0.4 || otherOverlap >= 0.35 ? 0.94 : 0.88;
      reason = 'other_project_mention';
    } else if (otherTitleStrength >= 0.6 && activeOverlap < 0.15) {
      conf = Math.min(0.92, 0.82 + (otherTitleStrength - 0.6) * 0.25);
      reason = 'other_session_topic_match';
    } else if (otherOverlap >= 0.55 && activeOverlap === 0 && tokens.length >= 3) {
      conf = 0.82;
      reason = 'other_session_topic_match';
    }

    // Dampen if the prompt is also anchored to the active session (incidental cross-reference).
    if (conf > 0 && anchoredToActive) {
      conf *= usedExtractedSubject ? 0.45 : 0.35;
    }

    if (conf > bestOtherConfidence) {
      bestOtherConfidence = conf;
      bestOther = other;
      bestOtherReason = reason;
    }
  }

  let confidence = bestOtherConfidence;
  let reason = bestOtherReason;
  let suggestedSession = bestOther;
  let suggestNew = false;

  // Check for explicit new-work / topic-shift signal when not targeting an existing session.
  const isNewWork = looksLikeNewWork(subjectText);
  if (isNewWork && !anchoredToActive) {
    const newConf = activeOverlap === 0 ? 0.9 : 0.82;
    if (newConf > confidence) {
      confidence = newConf;
      reason = 'new_work_topic_shift';
      suggestedSession = null;
      suggestNew = true;
    }
  }

  // Foreign file or explicit repo mention not matching activeContext or any otherContext.
  if (confidence < effThreshold && !anchoredToActive && activeOverlap === 0) {
    const foreignRepoMention = /\b(?:in|for|on)\s+(?:the\s+)?[a-z0-9_-]{3,40}\s+(?:repo|repository|project|codebase|service|app)\b/i.test(
      subjectText,
    );
    if (foreignRepoMention) {
      confidence = Math.max(confidence, 0.84);
      reason = 'foreign_project_mention';
      suggestedSession = null;
      suggestNew = true;
    } else if (mentionedFiles.length > 0 && Array.isArray(activeContext.recentFiles) && activeContext.recentFiles.length > 0) {
      // Mentions concrete file(s) with zero overlap against an active session that has tracked files.
      confidence = Math.max(confidence, 0.55);
      if (!reason) reason = 'untracked_file_mention';
    } else if (tokens.length >= 5) {
      // Mild heuristic mismatch (intentionally below 0.8 default threshold to avoid false alarms).
      confidence = Math.max(confidence, 0.45);
      if (!reason) reason = 'low_topic_overlap';
    }
  }

  confidence = Number(clamp01(confidence).toFixed(4));
  const drifted = confidence >= effThreshold;

  return {
    drifted,
    confidence,
    reason: drifted ? reason : null,
    suggestedSession: drifted ? suggestedSession : null,
    suggestNew: drifted ? suggestNew : false,
    warning: drifted ? buildWarning({ activeContext, suggestedSession, suggestNew }) : null,
  };
}
