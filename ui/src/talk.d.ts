export type ClaudeVoiceReady = { claudeFound: boolean; signedIn?: boolean | null; models: { state: "idle" | "downloading" | "ready" | "error"; percent: number; error: string } };
export type TalkBlocked = "grok-key" | "claude" | null;
export type TalkNotice = { kind: "grok-key" | "claude-missing" | "claude-signed-out" | "claude-models" | "claude-models-error"; text: string };
type ConfigLike = { hasKey: boolean; settings: { voiceEngine: "grok" | "claude" } } | null | undefined;

export const GROK_NEEDS_KEY: string;
export const CLAUDE_CODE_MISSING: string;
export const CLAUDE_NOT_SIGNED_IN: string;
export const CLAUDE_SIGN_IN_STEP: string;
export const CLAUDE_SETUP_URL: string;
export const CLAUDE_NPM_INSTALL: string;
export function claudeInstall(platform: string | undefined): { where: string; command: string };
export function claudeVoiceReady(status: ClaudeVoiceReady | null | undefined): boolean;
export function checkClaudeAgain(io: { fetchStatus: () => Promise<ClaudeVoiceReady | null> | ClaudeVoiceReady | null; startDownload: () => Promise<{ models?: ClaudeVoiceReady["models"] } | null> }): Promise<{ status: ClaudeVoiceReady | null; ready: boolean }>;
export function canTalk(config: ConfigLike): boolean;
export function screenFor<V extends string>(view: V): "settings" | "history" | "main";
export function talkNotice(blocked: TalkBlocked, config: ConfigLike, status: ClaudeVoiceReady | null): TalkNotice | null;
export function needsModelDownload(status: ClaudeVoiceReady | null): boolean;
