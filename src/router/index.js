// Barrel exports for the SP3-inspired routing, topic-drift, and prompt-queue subsystem.

export {
  extractRecentFiles,
  readRecentCommits,
  harvestSessionContext,
} from './context.js';

export {
  DEFAULT_WEIGHTS,
  isBareFollowUp,
  looksLikeNewWork,
  extractMentionedFiles,
  rankCandidates,
} from './ranker.js';

export {
  DEFAULT_DRIFT_THRESHOLD,
  checkTopicDrift,
} from './drift.js';

export {
  createPromptQueue,
} from './queue.js';
