import type { ClaudeVoiceReady } from "./talk.js";

export type VoiceSetupStatus = ClaudeVoiceReady & { mb?: number };
type Engine = "grok" | "claude";
type SettingsLike = { onboarded?: boolean; voiceEngine?: string } | null | undefined;

export const ONBOARDING_DONE: { onboarded: true };
export function onboardingShown(settings: SettingsLike, opts?: { parity?: boolean }): boolean;
export function engineOf(settings: SettingsLike): Engine;
export function voiceReady(engine: Engine, io?: { hasKey?: boolean; status?: VoiceSetupStatus | null }): boolean;
export function shouldDownload(engine: Engine, status: VoiceSetupStatus | null | undefined): boolean;
export function refreshVoiceSetup(io: {
  engine: Engine;
  fetchStatus: () => Promise<VoiceSetupStatus | null> | VoiceSetupStatus | null;
  startDownload: () => Promise<{ models?: VoiceSetupStatus["models"] } | null>;
}): Promise<VoiceSetupStatus | null>;
export function claudeCodeDetail(status: VoiceSetupStatus | null | undefined): string;
export function signInDetail(status: VoiceSetupStatus | null | undefined, signingIn: { error?: string | null } | null): string;
export function modelsDetail(status: VoiceSetupStatus | null | undefined, thisComputer?: string): string;
export function signInAndWait(io: {
  login: () => Promise<{ ok: boolean; error?: string } | null>;
  fetchStatus: () => Promise<VoiceSetupStatus | null> | VoiceSetupStatus | null;
  onStatus?: (st: VoiceSetupStatus) => void;
  cancelled?: () => boolean;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  everyMs?: number;
  limitMs?: number;
}): Promise<{ signedIn?: boolean; error?: string }>;
