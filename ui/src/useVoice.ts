// Mic -> bridge (-> Grok), Grok audio -> speakers, plus everything the UI shows:
// phase (listening / thinking / speaking), live volume levels for the orb, history, draft.
import { useCallback, useEffect, useRef, useState } from "react";
import { playChime, setChimeVolume } from "./sounds";
import { letItFinish, releaseTail, volumeGain } from "./playback.js";
import { desktop, isMac } from "./desktop";

/** A plain reason the mic didn't open (on a Mac, where to allow it). */
function micProblem(e: any) {
  if (e?.name === "NotAllowedError" && isMac) return "Orbit isn't allowed to use the microphone. Turn it on in System Settings → Privacy & Security → Microphone, then quit and reopen Orbit.";
  if (e?.name === "NotFoundError") return "No microphone found. Plug one in or pick one in your system's sound settings.";
  return `Microphone problem: ${e?.message || e}`;
}
import { createEmoteSync } from "./emote-sync.js";

const RATE = 24000;
const TAP_TIMEOUT_MS = 10_000; // "one question" mode: give up if you say nothing for this long
const TAP_DRAFT_HOLD_MS = 60_000; // "one question" mode: stay connected this long while a draft waits for a yes
const SECOND_BRAIN_MAX_MS = 330_000; // the longest a second-brain answer can take (Opus: 5 min) plus a margin
const MAX_HISTORY = 200;
const ANNOUNCE_LISTEN_MS = 3000; // spoken update: how long the mic stays open for a reply
const ANNOUNCE_GRACE_MS = 1000; // ...plus this, once, if you were just starting to talk
const ANNOUNCE_MAX_MS = 45_000; // give up on a spoken update that never gets said
const ANNOUNCE_HEARD_MS = 8000; // you started talking in the window: this long for it to become words
const ANNOUNCE_IDLE_MS = 20_000; // a conversation that began as a spoken update hangs up after this much quiet
const ANNOUNCE_SILENT_OPEN_MS = 2000; // Grok is done but nothing played (or it was silent): open the window anyway
const MAX_QUEUED_S = 120; // a play head this far ahead of the clock is stale, not a real queue

/** Why the page hung up, told to the bridge for its log (codes only). */
type ByeReason = "user" | "sleep" | "idle" | "tap_timeout" | "draft_hold" | "listen_expired" | "heard_no_words" | "announce_max" | "bridge" | "mic_error" | "closed" | "other";

// Sleeping means hanging up: nothing is billed, and "Hey Grok" / the hotkey start a fresh
// connection. The only "connected but not listening" moments are while Grok finishes its
// goodbye, and in "one question" mode while it answers (or while a draft waits for a yes).
//
// Spoken updates ("announce"): when Claude finishes while Grok is asleep, Orbit can connect just
// to say so. The mic isn't even opened until Grok's update has finished playing; then it listens
// for ~3 s. Speech there turns it into a normal conversation; silence hangs up. The bridge
// enforces the same window on its side.

export type Phase = "off" | "connecting" | "listening" | "thinking" | "speaking";
export type Caption = { id: string; who: "you" | "grok" | "note" | "error" | "sent"; text: string; at: number };
export type Draft = { id: number; text: string; targetTitle: string | null } | null;
export type VoiceOptions = { listenMode: "always" | "tap"; halfDuplex: boolean; volume: number };

const TOOL_NOTES: Record<string, string> = {
  get_current_session: "Checking your session…",
  list_sessions: "Listing sessions…",
  read_session: "Reading the session…",
  draft_prompt: "Drafting a prompt…",
  send_draft: "Sending to Claude…",
  copy_to_clipboard: "Copying…",
  switch_session: "Switching session…",
  new_session: "Starting a new session…",
  open_claude_sign_in: "Opening the Claude Code sign-in…",
};

// listening: the ~3 s window; heard: you started talking in it, waiting for your words.
// readyAt: when the bridge said Grok is done (0 = not yet).
type Announce = { stage: "speaking" | "listening" | "heard"; startedAt: number; ready: boolean; readyAt: number; grace: boolean; timer?: ReturnType<typeof setTimeout> };

function b64ToInt16(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

function bufToB64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function useVoice(options: VoiceOptions) {
  const [phase, setPhase] = useState<Phase>("off");
  const [asleep, setAsleep] = useState(false);
  const [levels, setLevels] = useState({ input: 0, output: 0 });
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [draft, setDraft] = useState<Draft>(null);
  const [hearing, setHearing] = useState(false); // Grok's voice detection says you are talking
  // Mute button: the call stays up and you still hear replies, but no mic audio is sent.
  const [muted, setMuted] = useState(false);
  const [sentCount, setSentCount] = useState(0); // prompts sent to Claude in this app session
  const [sending, setSending] = useState(false); // a prompt is on its way to Claude (send_draft is running)
  const [errorCount, setErrorCount] = useState(0); // errors shown (a tool that failed, a failed send, Grok's errors)
  const mutedRef = useRef(false);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const micSource = useRef<MediaStreamAudioSourceNode | null>(null);
  const worklet = useRef<AudioWorkletNode | null>(null);
  const announceRef = useRef<Announce | null>(null);
  const announcePoll = useRef<ReturnType<typeof setInterval>>(undefined);
  const lastLoudAt = useRef(0);
  const idlePoll = useRef<ReturnType<typeof setInterval>>(undefined);
  const lastActivity = useRef(0); // you spoke or typed
  const toolsRunning = useRef(0); // tool calls still running (a second-brain answer can take minutes)
  const analyser = useRef<AnalyserNode | null>(null);
  const outBus = useRef<GainNode | null>(null); // every chunk of the voice, before the volume (the orb and avatar read this level)
  const volumeNode = useRef<GainNode | null>(null); // Settings → Voice → Volume, between outBus and the speakers
  const playing = useRef(new Set<AudioBufferSourceNode>());
  // When the queued audio should have finished, by the wall clock. "Still playing" is judged by
  // this, not by `ended` events, so audio that never plays (a suspended output) can't keep a
  // spoken update's mic shut, or a hang-up waiting, forever.
  const audioEndsAt = useRef(0);
  const isPlaying = () => playing.current.size > 0 && Date.now() < audioEndsAt.current + 250;
  // A sound of Orbit's own playing (the avatar's "Wheee!"): treated like Orbit's voice by the listening.
  const ownSoundUntil = useRef(0);
  const soundPlaying = () => Date.now() < ownSoundUntil.current;
  const playHead = useRef(0); // where the next chunk starts, on this call's AudioContext clock
  /** How long after it's scheduled audio really comes out (Bluetooth earbuds: 0.1–0.3 s). */
  const outLatency = () => {
    const ac = ctx.current;
    const l = ac ? ac.outputLatency || ac.baseLatency || 0 : 0;
    return Number.isFinite(l) && l > 0 && l < 1 ? l : 0;
  };
  // The last chunk scheduled, for the release at the end of its reply (see addRelease).
  const lastChunk = useRef<{ pcm: Int16Array; endAt: number; released: boolean } | null>(null);
  // Counts only, told to the bridge at hang-up for its log: Grok audio scheduled and played (s),
  // and how far ahead of the clock the first chunk was scheduled.
  // cut: replies stopped with audio still to play (you talked over them); kept: talked over just
  // their last moments, so they were let finish.
  const audioStats = useRef({ scheduled: 0, played: 0, firstLead: 0, maxLead: 0, chunks: 0, cut: 0, kept: 0 });
  const timing = useRef(new WeakMap<AudioBufferSourceNode, { at: number; dur: number }>());
  const inLevel = useRef(0);
  const thinking = useRef(false);
  const ready = useRef(false);
  const asleepRef = useRef(false);
  const pendingText = useRef<string | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tapHold = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hangupPoll = useRef<ReturnType<typeof setInterval>>(undefined);
  const responding = useRef(false);
  const responseDoneAt = useRef(0);
  const lastAudioAt = useRef(0);
  const toolsInFlight = useRef(0);
  const draftRef = useRef<Draft>(null);
  draftRef.current = draft;
  const stopRef = useRef<(reason?: ByeReason) => void>(() => {});
  const opts = useRef(options);
  opts.current = options;
  // The avatar's feelings as the words play (emote cues; see emote-sync.js): timed on this call's
  // audio clock, with the output's latency, so each fires when its words come out of the speakers.
  const emotes = useRef(
    createEmoteSync({
      now: () => {
        const ac = ctx.current;
        return ac ? ac.currentTime - (ac.outputLatency || ac.baseLatency || 0) : 0;
      },
      fire: (cue) => desktop?.buddyEmote?.(cue),
    }),
  );
  const replyId = useRef<string>("reply"); // the reply now coming in (for events that don't say)
  const replyKey = (evt: any): string => String(evt.response_id || replyId.current);

  const caption = useCallback((raw: Omit<Caption, "at">, mode: "set" | "append" = "set") => {
    // Text only: Grok's events are passed through as they come, and anything but a string here
    // would make React throw and blank the window.
    const c = { ...raw, text: typeof raw.text === "string" ? raw.text : String(raw.text ?? "") };
    setCaptions((list) => {
      const i = list.findIndex((x) => x.id === c.id);
      if (i < 0) return [...list.slice(-(MAX_HISTORY - 1)), { ...c, at: Date.now() }];
      const next = list.slice();
      next[i] = { ...next[i], text: mode === "append" ? next[i].text + c.text : c.text };
      return next;
    });
  }, []);

  const setAsleepBoth = (v: boolean) => {
    asleepRef.current = v;
    setAsleep(v);
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "ui.state", asleep: v }));
  };

  /** Leave spoken-update mode (it became a normal conversation, or is ending). */
  const endAnnounce = () => {
    const a = announceRef.current;
    if (a) clearTimeout(a.timer);
    clearInterval(announcePoll.current);
    announceRef.current = null;
  };

  /** Open the microphone and start sending it (unless asleep). Needs the AudioContext from start(). */
  const openMic = useCallback(async () => {
    const ac = ctx.current;
    if (!ac || mic.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (ctx.current !== ac) {
      stream.getTracks().forEach((tr) => tr.stop()); // hung up meanwhile
      return;
    }
    if (!worklet.current) {
      await ac.audioWorklet.addModule("pcm-worklet.js");
      const node = new AudioWorkletNode(ac, "pcm-capture");
      worklet.current = node;
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        // Not listening: asleep, a spoken update whose listening window isn't open, or
        // (half-duplex) Grok is talking and might hear itself.
        const a = announceRef.current;
        const deaf = mutedRef.current || asleepRef.current || (!!a && a.stage === "speaking") || (opts.current.halfDuplex && (isPlaying() || soundPlaying()));
        const pcm = new Int16Array(e.data);
        let sum = 0;
        for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 0x8000) ** 2;
        inLevel.current = deaf ? 0 : Math.sqrt(sum / pcm.length);
        if (inLevel.current > 0.02) lastLoudAt.current = Date.now();
        if (!deaf && ws.current?.readyState === WebSocket.OPEN)
          ws.current.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bufToB64(e.data) }));
      };
    }
    if (ctx.current !== ac) {
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }
    mic.current = stream;
    micSource.current = ac.createMediaStreamSource(stream);
    micSource.current.connect(worklet.current);
  }, []);

  /** Close the microphone device itself (not just stop sending). */
  const closeMic = () => {
    micSource.current?.disconnect();
    mic.current?.getTracks().forEach((tr) => tr.stop());
    micSource.current = mic.current = null;
    inLevel.current = 0;
  };

  /** Close the mic right away (Grok can still finish what it's saying). */
  const muteMic = () => {
    setAsleepBoth(true);
    setHearing(false);
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
  };

  /**
   * Hang up once Grok has gone quiet (its audio has played out), or after `maxMs` at most.
   * `afterReply`: also wait for a reply that finishes after now (e.g. Grok's goodbye, which is
   * spoken after its go_to_sleep tool returns). `keepIfDraft` ("one question" mode): if a draft is
   * waiting for a yes, stay connected for a minute instead so the user can answer.
   */
  const hangUpWhenQuiet = useCallback((maxMs: number, { afterReply = false, keepIfDraft = false, waitForTools = false, reason = "sleep" as ByeReason } = {}) => {
    clearInterval(hangupPoll.current);
    const t0 = Date.now();
    let quietSince = 0; // must stay quiet ~1 s: there are short gaps between a tool call and the spoken reply
    hangupPoll.current = setInterval(() => {
      const now = Date.now();
      const quiet =
        !isPlaying() &&
        !responding.current &&
        toolsInFlight.current === 0 &&
        now - lastAudioAt.current > 600 &&
        (!afterReply || responseDoneAt.current > t0);
      quietSince = quiet ? quietSince || now : 0;
      // waitForTools: a second-brain question can take up to 5 minutes; don't cut it off.
      const limit = waitForTools && toolsInFlight.current > 0 ? Math.max(maxMs, SECOND_BRAIN_MAX_MS) : maxMs;
      if (!(quiet && now - quietSince >= 900) && now - t0 < limit) return;
      clearInterval(hangupPoll.current);
      if (keepIfDraft && draftRef.current && ws.current) {
        clearTimeout(tapHold.current);
        tapHold.current = setTimeout(() => stopRef.current("draft_hold"), TAP_DRAFT_HOLD_MS);
        return;
      }
      stopRef.current(reason);
    }, 150);
  }, []);

  /** Go to sleep = hang up (after Grok's goodbye). Nothing is billed while asleep. */
  const sleep = useCallback(
    (who: "user" | "grok" = "user", reason: ByeReason = "sleep") => {
      clearTimeout(tapTimer.current);
      clearTimeout(tapHold.current);
      if (!ws.current) return;
      endAnnounce();
      muteMic();
      playChime("sleep");
      hangUpWhenQuiet(who === "grok" ? 6000 : 3000, { afterReply: who === "grok", reason });
    },
    [hangUpWhenQuiet],
  );

  /** In "one question" mode, listen for one utterance; say nothing for 10 s and it hangs up. */
  const armTapTimeout = useCallback(() => {
    clearTimeout(tapTimer.current);
    if (opts.current.listenMode === "tap") tapTimer.current = setTimeout(() => sleep("user", "tap_timeout"), TAP_TIMEOUT_MS);
  }, [sleep]);

  /** "One question" mode, while a draft waits: open the mic again for the answer. */
  const wake = useCallback(() => {
    if (!asleepRef.current || !ws.current) return;
    clearInterval(hangupPoll.current);
    clearTimeout(tapHold.current);
    setAsleepBoth(false);
    playChime("wake");
    armTapTimeout();
  }, [armTapTimeout]);

  /** Spoken update: Grok is done and its audio has played out, so open the mic for a short reply. */
  const openListenWindow = useCallback(async () => {
    const a = announceRef.current;
    if (!a || a.stage !== "speaking" || !ws.current) return;
    a.stage = "listening";
    playChime("wake"); // you hear when the mic opens; it plays out before the mic starts
    await new Promise((r) => setTimeout(r, 450));
    if (announceRef.current !== a || a.stage !== "listening") return;
    try {
      await openMic();
    } catch (e: any) {
      caption({ id: `err-${Date.now()}`, who: "error", text: `Microphone problem: ${e.message}` });
      stopRef.current("mic_error");
      return;
    }
    if (announceRef.current === a && a.stage !== "listening") return closeMic(); // Grok started speaking again
    if (announceRef.current !== a || ws.current?.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify({ type: "ui.listen_window" }));
    caption({ id: `note-${Date.now()}`, who: "note", text: `Listening for ${ANNOUNCE_LISTEN_MS / 1000} seconds…` });
    const check = () => {
      if (announceRef.current !== a || a.stage !== "listening") return;
      // You may have started talking just as the window closed: give the voice detection a moment.
      if (!a.grace && Date.now() - lastLoudAt.current < 400) {
        a.grace = true;
        a.timer = setTimeout(check, ANNOUNCE_GRACE_MS);
        return;
      }
      stopRef.current("listen_expired"); // nothing said: back to sleep (hang up)
    };
    clearTimeout(a.timer);
    a.timer = setTimeout(check, ANNOUNCE_LISTEN_MS);
  }, [caption, openMic]);

  /**
   * Spoken update: wait until the bridge says Grok is done and its audio has finished playing,
   * then open the mic. If nothing played (Grok was silent, or the audio never came out), it
   * opens anyway after a couple of seconds of quiet, so you can always answer or say "go to sleep".
   */
  const watchAnnounce = useCallback(() => {
    clearInterval(announcePoll.current);
    const a = announceRef.current;
    if (!a) return;
    let quietSince = 0;
    announcePoll.current = setInterval(() => {
      const cur = announceRef.current;
      if (cur !== a || a.stage !== "speaking") return clearInterval(announcePoll.current);
      const now = Date.now();
      if (now - a.startedAt > ANNOUNCE_MAX_MS) {
        clearInterval(announcePoll.current);
        stopRef.current("announce_max");
        return;
      }
      if (ctx.current?.state === "suspended") void ctx.current.resume().catch(() => {});
      const quiet = a.ready && !isPlaying() && !soundPlaying() && !responding.current && now - lastAudioAt.current > 300;
      quietSince = quiet ? quietSince || now : 0;
      const heardIt = lastAudioAt.current > a.startedAt;
      if (quiet && now - quietSince >= (heardIt ? 300 : ANNOUNCE_SILENT_OPEN_MS)) {
        clearInterval(announcePoll.current);
        void openListenWindow();
      }
    }, 100);
  }, [openListenWindow]);

  /**
   * You answered a spoken update: carry on as a normal conversation. Since you didn't start it,
   * it hangs up by itself after 20 s of quiet (a minute while a draft waits for your yes).
   */
  const answeredAnnounce = useCallback(() => {
    endAnnounce();
    clearInterval(idlePoll.current);
    lastActivity.current = Date.now();
    idlePoll.current = setInterval(() => {
      if (!ws.current) return clearInterval(idlePoll.current);
      const busy = isPlaying() || responding.current || toolsRunning.current > 0 || asleepRef.current;
      const last = Math.max(lastActivity.current, lastAudioAt.current, responseDoneAt.current);
      if (!busy && Date.now() - last > (draftRef.current ? TAP_DRAFT_HOLD_MS : ANNOUNCE_IDLE_MS)) {
        clearInterval(idlePoll.current);
        sleep("user", "idle");
      }
    }, 1000);
  }, [sleep]);

  /** Seconds of Grok audio actually played out so far, from what was scheduled and the clock. */
  const playedSoFar = () => {
    const ac = ctx.current;
    let s = audioStats.current.played;
    if (ac) for (const src of playing.current) {
      const t = timing.current.get(src);
      if (t) s += Math.min(t.dur, Math.max(0, ac.currentTime - t.at));
    }
    return s;
  };

  const stopPlayback = useCallback(() => {
    const ac = ctx.current;
    if (ac && playHead.current - ac.currentTime > 0.05 && playing.current.size) audioStats.current.cut++;
    lastChunk.current = null;
    for (const s of playing.current) {
      const t = timing.current.get(s);
      if (t && ac) audioStats.current.played += Math.min(t.dur, Math.max(0, ac.currentTime - t.at));
      try {
        s.onended = null;
        s.stop();
      } catch {}
    }
    playing.current.clear();
    audioEndsAt.current = 0;
    if (ac) playHead.current = ac.currentTime;
    emotes.current.clear(); // nothing still to play: no feelings for it either
  }, []);

  /** Schedule a chunk of the voice; returns when it plays (this call's clock), how long, and its samples. */
  const playPcm = useCallback((b64: string): { at: number; dur: number; pcm: Int16Array } | null => {
    const ac = ctx.current;
    if (!ac || !outBus.current) return null;
    const pcm = b64ToInt16(b64);
    if (!pcm.length) return null;
    if (ac.state === "suspended") void ac.resume().catch(() => {});
    const buffer = ac.createBuffer(1, pcm.length, RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(outBus.current);
    // The play head is this AudioContext's clock. (It used to carry over from the previous call's
    // context, whose clock had run for that whole call: with nobody speaking first, as on a
    // spoken update, Grok's audio was scheduled that many seconds into the future, so it was
    // never heard. start() now resets it, and a head far ahead of the clock is pulled back.)
    if (playHead.current > ac.currentTime + MAX_QUEUED_S) playHead.current = ac.currentTime;
    playHead.current = Math.max(playHead.current, ac.currentTime + 0.03);
    const at = playHead.current;
    src.start(at);
    playHead.current += buffer.duration;
    // Wall-clock end of everything queued (see isPlaying), when it is actually heard.
    audioEndsAt.current = Date.now() + (playHead.current - ac.currentTime + outLatency()) * 1000;
    lastChunk.current = { pcm, endAt: playHead.current, released: false };
    const st = audioStats.current;
    const lead = at - ac.currentTime;
    if (st.chunks === 0) st.firstLead = lead;
    st.maxLead = Math.max(st.maxLead, lead);
    st.scheduled += buffer.duration;
    st.chunks++;
    timing.current.set(src, { at, dur: buffer.duration });
    playing.current.add(src);
    src.onended = () => {
      if (!playing.current.delete(src)) return;
      st.played += Math.min(buffer.duration, Math.max(0, ac.currentTime - at));
    };
    return { at, dur: buffer.duration, pcm };
  }, []);

  /**
   * The reply's audio is all here: if it ends abruptly (still sounding in its last 10 ms, as a TTS
   * clip or Grok's last chunk can), let it fall away naturally over ~120 ms right after its real
   * end (see releaseTail), instead of stopping dead. Never before that end, and only if nothing
   * else is queued after it and it hasn't finished playing yet.
   */
  const addRelease = useCallback(() => {
    const ac = ctx.current;
    const lc = lastChunk.current;
    if (!ac || !outBus.current || !lc || lc.released) return;
    lc.released = true;
    if (Math.abs(playHead.current - lc.endAt) > 1e-6 || lc.endAt < ac.currentTime + 0.005) return;
    const tail = releaseTail(lc.pcm, RATE);
    if (!tail) return;
    const buffer = ac.createBuffer(1, tail.length, RATE);
    buffer.getChannelData(0).set(tail);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(outBus.current);
    src.start(lc.endAt);
    playHead.current = lc.endAt + buffer.duration;
    audioEndsAt.current = Date.now() + (playHead.current - ac.currentTime + outLatency()) * 1000;
    playing.current.add(src);
    src.onended = () => void playing.current.delete(src);
  }, []);

  const sendText = useCallback(
    (text: string) => {
      if (!ws.current || !text.trim()) return;
      if (announceRef.current) {
        // Typing during a spoken update answers it: carry on as a normal conversation.
        answeredAnnounce();
        openMic().catch((e) => caption({ id: `err-${Date.now()}`, who: "error", text: micProblem(e) }));
      }
      lastActivity.current = Date.now();
      caption({ id: `typed-${Date.now()}`, who: "you", text });
      ws.current.send(JSON.stringify({ type: "ui.text", text }));
      thinking.current = true;
    },
    [caption, openMic, answeredAnnounce],
  );

  const handle = useCallback(
    (evt: any) => {
      const t: string = evt.type || "";
      switch (t) {
        case "bridge.ready":
          ready.current = true;
          if (announceRef.current) {
            // Woken only to say what Claude finished: no wake chime, mic still closed.
            ws.current?.send(JSON.stringify({ type: "ui.state", asleep: false }));
            watchAnnounce();
            return;
          }
          playChime("wake");
          ws.current?.send(JSON.stringify({ type: "ui.state", asleep: asleepRef.current }));
          if (pendingText.current) {
            sendText(pendingText.current);
            pendingText.current = null;
          } else {
            armTapTimeout();
          }
          return;
        case "bridge.error":
          caption({ id: `err-${Date.now()}`, who: "error", text: evt.message });
          setErrorCount((n) => n + 1);
          return;
        case "bridge.closed":
          caption({ id: `err-${Date.now()}`, who: "error", text: `Grok disconnected${evt.reason ? `: ${evt.reason}` : "."}` });
          setErrorCount((n) => n + 1);
          return;
        case "bridge.sleep":
          // "Go to sleep" means now: no goodbye, no waiting for Grok to finish. Stop what's playing,
          // close the mic and hang up straight away (the chime says it happened).
          clearTimeout(tapTimer.current);
          clearTimeout(tapHold.current);
          stopPlayback();
          playChime("sleep");
          stopRef.current("sleep");
          return;
        case "bridge.announce":
          if (!evt.ok) stopRef.current("bridge"); // nothing (left) to say, or the window ended: hang up
          return;
        case "bridge.announce_ready":
          if (announceRef.current) Object.assign(announceRef.current, { ready: true, readyAt: Date.now() });
          return;
        case "bridge.session":
          setSessionTitle(evt.title);
          return;
        case "bridge.draft":
          setDraft(evt.draft ? { id: evt.draft.id, text: evt.draft.text, targetTitle: evt.draft.targetTitle } : null);
          return;
        case "bridge.copied": {
          // Show what was copied, so nothing lands on the clipboard unseen before you paste it.
          const preview = String(evt.preview || "");
          caption({ id: `copied-${Date.now()}`, who: "note", text: `Copied to clipboard ✓ (${evt.chars} characters): ${preview}${evt.chars > preview.length ? "…" : ""}` });
          return;
        }
        case "bridge.avatar":
          // The avatar is doing what you asked. By the fast path (no model turn): nothing more is
          // coming, so stop anything Grok had already started saying, and stop "thinking".
          if (evt.fast) {
            stopPlayback();
            thinking.current = false;
          }
          return;
        case "bridge.brain":
          caption({ id: `brain-${Date.now()}`, who: "note", text: `Claude is reading ${evt.project}…` });
          return;
        case "bridge.sent":
          caption({ id: `sent-${Date.now()}`, who: "sent", text: evt.text });
          setSentCount((n) => n + 1);
          return;
        case "bridge.tool":
          thinking.current = true;
          toolsInFlight.current++;
          toolsRunning.current++;
          // Own keys only: a tool name like "__proto__" from Grok is not a note (it once blanked the
          // window: an object as caption text made React throw; found by the end-to-end fuzzer).
          if (typeof evt.name === "string" && Object.hasOwn(TOOL_NOTES, evt.name)) caption({ id: `tool-${Date.now()}`, who: "note", text: TOOL_NOTES[evt.name] });
          if (evt.name === "send_draft") setSending(true);
          return;
        case "bridge.tool_result":
          toolsInFlight.current = Math.max(0, toolsInFlight.current - 1);
          toolsRunning.current = Math.max(0, toolsRunning.current - 1);
          if (evt.name === "send_draft") setSending(false);
          if (evt.result && (evt.result.error || evt.result.ok === false)) {
            caption({ id: `err-${Date.now()}`, who: "error", text: String(evt.result.message || evt.result.error || "That didn't work.") });
            setErrorCount((n) => n + 1);
          }
          if (evt.result?.open_in_app) setSessionTitle(evt.result.open_in_app);
          if (evt.result?.deferred) caption({ id: `brain-${Date.now()}`, who: "note", text: "Claude is still thinking. Grok will tell you when the answer is ready." });
          return;
        case "error":
          caption({ id: `err-${Date.now()}`, who: "error", text: evt.error?.message || "Grok reported an error." });
          setErrorCount((n) => n + 1);
          return;
        case "response.output_audio.delta":
        case "response.audio.delta": {
          thinking.current = false;
          lastAudioAt.current = Date.now();
          const r = playPcm(evt.delta);
          const cue = evt.emote && typeof evt.emote.name === "string" ? { name: evt.emote.name, offset: 0 } : null;
          if (r) emotes.current.audio(replyKey(evt), r.at, r.dur, r.pcm, cue);
          else if (cue && ctx.current) emotes.current.audio(replyKey(evt), Math.max(playHead.current, ctx.current.currentTime), 0, null, cue); // a feeling after the last words
          return;
        }
        case "response.output_audio.done":
        case "response.audio.done":
          emotes.current.audioDone(replyKey(evt));
          addRelease();
          return;
        case "bridge.emote":
          // A cue in the reply's transcript (Grok): placed on the reply's audio when its words play.
          if (typeof evt.cue === "string") emotes.current.cue(replyKey(evt), evt.cue, typeof evt.at === "number" ? evt.at : 0);
          return;
        case "response.created": {
          if (evt.response?.id) replyId.current = String(evt.response.id);
          responding.current = true;
          const a = announceRef.current;
          if (a) {
            // Spoken update: Grok speaks again (e.g. another session finished) before you said
            // anything. Close the mic again; it reopens for a fresh window once Grok is done.
            a.ready = false;
            if (a.stage === "listening") {
              clearTimeout(a.timer);
              a.stage = "speaking";
              a.grace = false;
              closeMic();
            }
            watchAnnounce();
          }
          return;
        }
        case "input_audio_buffer.speech_started": {
          const a = announceRef.current;
          if (a && a.stage === "listening") {
            // You started talking in the window. It only counts once it's words (a cough doesn't);
            // keep listening a few seconds for them.
            clearTimeout(a.timer);
            a.stage = "heard";
            a.timer = setTimeout(() => announceRef.current === a && stopRef.current("heard_no_words"), ANNOUNCE_HEARD_MS);
          }
          lastActivity.current = Date.now();
          clearTimeout(tapTimer.current);
          setHearing(true);
          thinking.current = false;
          // You started talking: Grok is interrupted. Except over the very end of a reply that has all
          // arrived ("yes" over "...send it?"): that's you answering it, so its last word plays out.
          // (The voice detector only says so a quarter second into your words, which used to clip
          // the end of nearly every reply you answered quickly.)
          {
            const ac = ctx.current;
            const remainingS = ac && playing.current.size ? playHead.current - ac.currentTime + outLatency() : 0;
            if (letItFinish({ remainingS, replyDone: !responding.current })) audioStats.current.kept++;
            else stopPlayback();
          }
          return;
        }
        case "input_audio_buffer.speech_stopped":
        case "input_audio_buffer.committed":
          setHearing(false);
          thinking.current = true;
          // "One question" mode: you've asked it, so close the mic; hang up once Grok has answered
          // (or wait a minute if it drafted a prompt that needs your yes).
          if (opts.current.listenMode === "tap" && !asleepRef.current) {
            clearTimeout(tapTimer.current);
            muteMic();
            hangUpWhenQuiet(90_000, { afterReply: true, keepIfDraft: true, waitForTools: true });
          }
          return;
        case "response.done":
          emotes.current.audioDone(replyKey({ response_id: evt.response?.id }));
          if (evt.response?.status !== "cancelled") addRelease();
          thinking.current = false;
          responding.current = false;
    toolsInFlight.current = 0;
          responseDoneAt.current = Date.now();
          return;
      }
      if (t.startsWith("conversation.item.input_audio_transcription")) {
        // Real words in reply to a spoken update: from here on, a normal conversation.
        if (announceRef.current && typeof evt.transcript === "string" && /[\p{L}\p{N}]/u.test(evt.transcript)) answeredAnnounce();
        const id = `you-${evt.item_id}`;
        if (evt.transcript != null) caption({ id, who: "you", text: evt.transcript });
        else if (evt.delta) caption({ id, who: "you", text: evt.delta }, "append");
      } else if (t.startsWith("response.") && (t.includes("transcript") || t.includes("output_text") || t === "response.text.delta")) {
        const id = `grok-${evt.item_id || evt.response_id}`;
        if (t.endsWith(".delta") && evt.delta) caption({ id, who: "grok", text: evt.delta }, "append");
        else if (t.endsWith(".done") && evt.transcript) caption({ id, who: "grok", text: evt.transcript });
        if (t.endsWith(".delta") && typeof evt.delta === "string") emotes.current.text(replyKey(evt), evt.delta);
        else if (t.endsWith(".done")) emotes.current.textDone(replyKey(evt), typeof evt.transcript === "string" ? evt.transcript : undefined);
      }
    },
    [caption, playPcm, addRelease, stopPlayback, sleep, sendText, armTapTimeout, hangUpWhenQuiet, watchAnnounce, answeredAnnounce],
  );

  /** Hang up now. `reason` goes to the bridge's log (a code, nothing else). */
  const stop = useCallback((reason: ByeReason = "other") => {
    clearTimeout(tapTimer.current);
    clearTimeout(tapHold.current);
    clearInterval(hangupPoll.current);
    clearInterval(idlePoll.current);
    endAnnounce();
    toolsRunning.current = 0;
    responding.current = false;
    if (ws.current?.readyState === WebSocket.OPEN) {
      const st = audioStats.current;
      const r1 = (n: number) => Math.round(n * 10) / 10;
      try {
        ws.current.send(
          JSON.stringify({ type: "ui.bye", reason, audio: ctx.current?.state ?? "none", scheduled: r1(st.scheduled), played: r1(playedSoFar()), lead: r1(st.firstLead), maxLead: r1(st.maxLead), cut: st.cut, kept: st.kept }),
        );
      } catch {}
    }
    ws.current?.close();
    ws.current = null;
    stopPlayback();
    closeMic();
    worklet.current?.disconnect();
    ctx.current?.close();
    ctx.current = worklet.current = analyser.current = outBus.current = volumeNode.current = null;
    playHead.current = 0; // the next call has a new AudioContext, whose clock starts at 0
    ready.current = false;
    thinking.current = false;
    asleepRef.current = false;
    setAsleep(false);
    setPhase("off");
    setLevels({ input: 0, output: 0 });
    setHearing(false);
    setSending(false);
  }, [stopPlayback]);
  stopRef.current = stop;

  /** Connect. `announce`: woken only to say what Claude finished (the mic stays closed for now). */
  const start = useCallback(async ({ announce = false }: { announce?: boolean } = {}) => {
    if (ws.current) return;
    setPhase("connecting");
    mutedRef.current = false; // every call starts with the mic live
    setMuted(false);
    try {
      const ac = new AudioContext({ sampleRate: RATE });
      ctx.current = ac;
      // Playback is timed on this context's own clock, from 0.
      playHead.current = 0;
      audioEndsAt.current = 0;
      audioStats.current = { scheduled: 0, played: 0, firstLead: 0, maxLead: 0, chunks: 0, cut: 0, kept: 0 };
      playing.current.clear();
      if (ac.state === "suspended") void ac.resume();
      // The voice -> outBus -> volume -> speakers. The level the orb and the avatar move with is read
      // before the volume (an analyser on outBus), so they react the same however quiet it plays.
      outBus.current = ac.createGain();
      analyser.current = ac.createAnalyser();
      analyser.current.fftSize = 512;
      outBus.current.connect(analyser.current);
      volumeNode.current = ac.createGain();
      volumeNode.current.gain.value = volumeGain(opts.current.volume);
      outBus.current.connect(volumeNode.current);
      volumeNode.current.connect(ac.destination);
      if (announce) announceRef.current = { stage: "speaking", startedAt: Date.now(), ready: false, readyAt: 0, grace: false };
      else await openMic();
    } catch (e: any) {
      caption({ id: `err-${Date.now()}`, who: "error", text: `Microphone problem: ${e.message}` });
      stop("mic_error");
      return;
    }

    // ?announce=1: the bridge drops all mic audio until the listening window, and says the update.
    const sock = new WebSocket(`ws://${location.host}/voice${announce ? "?announce=1" : ""}`);
    ws.current = sock;
    sock.onmessage = (m) => {
      try {
        handle(JSON.parse(m.data));
      } catch (e) {
        console.error(e);
      }
    };
    sock.onclose = () => {
      if (ws.current === sock) stop("closed");
    };
  }, [caption, handle, stop]);

  // ~20 fps: work out the phase and the volume levels that drive the orb.
  useEffect(() => {
    if (phase === "off") return;
    const buf = new Float32Array(512);
    let out = 0;
    let inp = 0;
    const id = setInterval(() => {
      // Hung up (stop() has run) but React hasn't re-rendered yet: don't turn "off" back into
      // "connecting" (that left the orb stuck on "Connecting…" after a hang-up).
      if (!ctx.current) return;
      if (analyser.current) {
        analyser.current.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        out = Math.max(Math.sqrt(sum / buf.length), out * 0.8);
      }
      inp = Math.max(inLevel.current, inp * 0.8);
      setLevels({ input: Math.min(1, inp * 6), output: Math.min(1, out * 5) });
      setPhase(
        !ready.current
          ? "connecting"
          : isPlaying()
            ? "speaking"
            : thinking.current || (announceRef.current && announceRef.current.stage === "speaking") // spoken update: the mic is closed
              ? "thinking"
              : "listening",
      );
    }, 50);
    return () => clearInterval(id);
  }, [phase === "off"]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => stop("closed"), [stop]);

  // The volume applies at once, mid-sentence too (a short glide, so it never clicks); the chimes follow it.
  useEffect(() => {
    setChimeVolume(options.volume);
    const ac = ctx.current;
    if (ac && volumeNode.current) volumeNode.current.gain.setTargetAtTime(volumeGain(options.volume), ac.currentTime, 0.03);
  }, [options.volume]);

  /**
   * Hotkey, orb click/right-click and "Hey Grok": start if asleep (hung up); otherwise go to sleep.
   * During a spoken update Grok started by itself, it hangs up right away (no goodbye to wait for).
   */
  const hotkey = useCallback(() => {
    if (!ws.current) start();
    else if (announceRef.current) stop("user");
    else if (asleepRef.current) wake(); // "one question" mode: a draft is waiting for your answer
    else sleep();
  }, [start, wake, sleep, stop]);

  /** Ask Grok something in text, connecting first if needed (used by the session switcher). */
  const ask = useCallback(
    (text: string) => {
      if (ws.current && ready.current) sendText(text);
      else {
        pendingText.current = text;
        start();
      }
    },
    [sendText, start],
  );

  // Developer testing only (the parity suite, parity/PROTOCOL.md): the driver reads the voice state
  // from here. window.__orbitParity exists only when the parity driver's own preload put it there
  // (electron/parity-preload.cjs, never in the installed app), so other pages expose nothing.
  const parity = (window as any).__orbitParity;
  if (parity) {
    parity.voice = () => {
      const st = audioStats.current;
      const lastError = [...captions].reverse().find((c) => c.who === "error")?.text ?? null;
      return {
        phase,
        asleep,
        connected: ws.current?.readyState === WebSocket.OPEN && ready.current,
        muted,
        playedMs: Math.round(playedSoFar() * 1000),
        scheduledMs: Math.round(st.scheduled * 1000),
        chunks: st.chunks,
        lastError: lastError && lastError.slice(0, 200),
        draft: draft && { id: draft.id, text: draft.text, targetTitle: draft.targetTitle },
        sentCount,
      };
    };
  }

  return {
    phase,
    asleep,
    levels,
    captions,
    draft,
    hearing,
    sessionTitle,
    setSessionTitle,
    start: () => start(),
    stop: () => stop("user"),
    /** A spoken update is on (Grok woke by itself): end it now. Returns false if there is none. */
    endWake: () => {
      if (!announceRef.current || !ws.current) return false;
      stop("user");
      return true;
    },
    /** Claude finished while Grok is off: connect just to say so, then listen ~3 s for a reply. */
    announce: () => {
      if (!ws.current) void start({ announce: true });
    },
    sleep: () => sleep(),
    wake,
    muted,
    sentCount,
    sending,
    errorCount,
    /** Mute or unmute the mic for this call. Muting also drops any half-heard speech. */
    toggleMute: () => {
      const next = !mutedRef.current;
      mutedRef.current = next;
      setMuted(next);
      if (next) {
        setHearing(false);
        if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      }
    },
    toggleSleep: hotkey,
    hotkey,
    /** A sound of Orbit's own is playing for `ms` (the avatar's throw sound): listened to like its voice. */
    ownSound: (ms: number) => {
      ownSoundUntil.current = Math.max(ownSoundUntil.current, Date.now() + Math.max(0, ms));
    },
    sendText,
    ask,
    note: (text: string) => caption({ id: `note-${Date.now()}`, who: "note", text }),
  };
}
