// Barrel exports for Orbit's TargetBackend abstraction and implementations.

export {
  TARGET_BACKENDS,
  REQUIRED_BACKEND_METHODS,
  normalizeSession,
  assertTargetBackend,
  createTargetRegistry,
} from './interface.js';
export { CLAUDE_DESKTOP_CAPABILITIES, createClaudeDesktopTarget } from './claude-desktop.js';
export { T3_CODE_CAPABILITIES, createT3Target } from './t3-code.js';
