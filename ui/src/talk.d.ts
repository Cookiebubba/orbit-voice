export type ClaudeVoiceReady = { claudeFound: boolean; models: { state: "idle" | "downloading" | "ready" | "error"; percent: number; error: string } };
export type TalkBlocked = "grok-key" | "claude" | null;
export type TalkNotice = { kind: "grok-key" | "claude-missing" | "claude-models" | "claude-models-error"; text: string };
type ConfigLike = { hasKey: boolean; settings: { voiceEngine: "grok" | "claude" } } | null | undefined;

export const GROK_NEEDS_KEY: string;
export const CLAUDE_CODE_MISSING: string;
export function canTalk(config: ConfigLike): boolean;
export function screenFor<V extends string>(view: V): "settings" | "history" | "main";
export function talkNotice(blocked: TalkBlocked, config: ConfigLike, status: ClaudeVoiceReady | null): TalkNotice | null;
export function needsModelDownload(status: ClaudeVoiceReady | null): boolean;
