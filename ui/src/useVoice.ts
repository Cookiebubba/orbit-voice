// Mic -> bridge (-> Grok), Grok audio -> speakers, plus everything the UI shows:
// phase (listening / thinking / speaking), live volume levels for the orb, history, draft.
import { useCallback, useEffect, useRef, useState } from "react";
import { playChime } from "./sounds";

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
export type VoiceOptions = { listenMode: "always" | "tap"; halfDuplex: boolean };

const TOOL_NOTES: Record<string, string> = {
  get_current_session: "Checking your session…",
  list_sessions: "Listing sessions…",
  read_session: "Reading the session…",
  draft_prompt: "Drafting a prompt…",
  send_draft: "Sending to Claude…",
  copy_to_clipboard: "Copying…",
  switch_session: "Switching session…",
  new_session: "Starting a new session…",
};

// listening: the ~3 s window; heard: you started talking in it, waiting for your words.
type Announce = { stage: "speaking" | "listening" | "heard"; startedAt: number; ready: boolean; grace: boolean; timer?: ReturnType<typeof setTimeout> };

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
  const outBus = useRef<GainNode | null>(null);
  const playing = useRef(new Set<AudioBufferSourceNode>());
  const playHead = useRef(0);
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
  const stopRef = useRef<() => void>(() => {});
  const opts = useRef(options);
  opts.current = options;

  const caption = useCallback((c: Omit<Caption, "at">, mode: "set" | "append" = "set") => {
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
        const deaf = asleepRef.current || (!!a && a.stage === "speaking") || (opts.current.halfDuplex && playing.current.size > 0);
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
  const hangUpWhenQuiet = useCallback((maxMs: number, { afterReply = false, keepIfDraft = false, waitForTools = false } = {}) => {
    clearInterval(hangupPoll.current);
    const t0 = Date.now();
    let quietSince = 0; // must stay quiet ~1 s: there are short gaps between a tool call and the spoken reply
    hangupPoll.current = setInterval(() => {
      const now = Date.now();
      const quiet =
        playing.current.size === 0 &&
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
        tapHold.current = setTimeout(() => stopRef.current(), TAP_DRAFT_HOLD_MS);
        return;
      }
      stopRef.current();
    }, 150);
  }, []);

  /** Go to sleep = hang up (after Grok's goodbye). Nothing is billed while asleep. */
  const sleep = useCallback(
    (reason: "user" | "grok" = "user") => {
      clearTimeout(tapTimer.current);
      clearTimeout(tapHold.current);
      if (!ws.current) return;
      endAnnounce();
      muteMic();
      playChime("sleep");
      hangUpWhenQuiet(reason === "grok" ? 6000 : 3000, { afterReply: reason === "grok" });
    },
    [hangUpWhenQuiet],
  );

  /** In "one question" mode, listen for one utterance; say nothing for 10 s and it hangs up. */
  const armTapTimeout = useCallback(() => {
    clearTimeout(tapTimer.current);
    if (opts.current.listenMode === "tap") tapTimer.current = setTimeout(() => sleep(), TAP_TIMEOUT_MS);
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
      stopRef.current();
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
      stopRef.current(); // nothing said: back to sleep (hang up)
    };
    clearTimeout(a.timer);
    a.timer = setTimeout(check, ANNOUNCE_LISTEN_MS);
  }, [caption, openMic]);

  /** Spoken update: wait until the bridge says Grok is done and its audio has finished playing. */
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
        stopRef.current();
        return;
      }
      const quiet = a.ready && lastAudioAt.current > a.startedAt && playing.current.size === 0 && !responding.current && now - lastAudioAt.current > 300;
      quietSince = quiet ? quietSince || now : 0;
      if (quiet && now - quietSince >= 300) {
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
      const busy = playing.current.size > 0 || responding.current || toolsRunning.current > 0 || asleepRef.current;
      const last = Math.max(lastActivity.current, lastAudioAt.current, responseDoneAt.current);
      if (!busy && Date.now() - last > (draftRef.current ? TAP_DRAFT_HOLD_MS : ANNOUNCE_IDLE_MS)) {
        clearInterval(idlePoll.current);
        sleep();
      }
    }, 1000);
  }, [sleep]);

  const stopPlayback = useCallback(() => {
    for (const s of playing.current) {
      try {
        s.stop();
      } catch {}
    }
    playing.current.clear();
    if (ctx.current) playHead.current = ctx.current.currentTime;
  }, []);

  const playPcm = useCallback((b64: string) => {
    const ac = ctx.current;
    if (!ac || !outBus.current) return;
    const pcm = b64ToInt16(b64);
    if (!pcm.length) return;
    const buffer = ac.createBuffer(1, pcm.length, RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(outBus.current);
    playHead.current = Math.max(playHead.current, ac.currentTime + 0.03);
    src.start(playHead.current);
    playHead.current += buffer.duration;
    playing.current.add(src);
    src.onended = () => playing.current.delete(src);
  }, []);

  const sendText = useCallback(
    (text: string) => {
      if (!ws.current || !text.trim()) return;
      if (announceRef.current) {
        // Typing during a spoken update answers it: carry on as a normal conversation.
        answeredAnnounce();
        openMic().catch((e) => caption({ id: `err-${Date.now()}`, who: "error", text: `Microphone problem: ${e.message}` }));
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
          return;
        case "bridge.closed":
          caption({ id: `err-${Date.now()}`, who: "error", text: `Grok disconnected${evt.reason ? `: ${evt.reason}` : "."}` });
          return;
        case "bridge.sleep":
          sleep("grok");
          return;
        case "bridge.announce":
          if (!evt.ok) stopRef.current(); // nothing (left) to say, or the window ended: hang up
          return;
        case "bridge.announce_ready":
          if (announceRef.current) announceRef.current.ready = true;
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
        case "bridge.brain":
          caption({ id: `brain-${Date.now()}`, who: "note", text: `Claude is reading ${evt.project}…` });
          return;
        case "bridge.sent":
          caption({ id: `sent-${Date.now()}`, who: "sent", text: evt.text });
          return;
        case "bridge.tool":
          thinking.current = true;
          toolsInFlight.current++;
          toolsRunning.current++;
          if (TOOL_NOTES[evt.name]) caption({ id: `tool-${Date.now()}`, who: "note", text: TOOL_NOTES[evt.name] });
          return;
        case "bridge.tool_result":
          toolsInFlight.current = Math.max(0, toolsInFlight.current - 1);
          toolsRunning.current = Math.max(0, toolsRunning.current - 1);
          if (evt.result && (evt.result.error || evt.result.ok === false))
            caption({ id: `err-${Date.now()}`, who: "error", text: evt.result.message || evt.result.error });
          if (evt.result?.open_in_app) setSessionTitle(evt.result.open_in_app);
          return;
        case "error":
          caption({ id: `err-${Date.now()}`, who: "error", text: evt.error?.message || "Grok reported an error." });
          return;
        case "response.output_audio.delta":
        case "response.audio.delta":
          thinking.current = false;
          lastAudioAt.current = Date.now();
          playPcm(evt.delta);
          return;
        case "response.created": {
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
            a.timer = setTimeout(() => announceRef.current === a && stopRef.current(), ANNOUNCE_HEARD_MS);
          }
          lastActivity.current = Date.now();
          clearTimeout(tapTimer.current);
          setHearing(true);
          thinking.current = false;
          stopPlayback(); // you started talking: let Grok be interrupted
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
      }
    },
    [caption, playPcm, stopPlayback, sleep, sendText, armTapTimeout, hangUpWhenQuiet, watchAnnounce, answeredAnnounce],
  );

  const stop = useCallback(() => {
    clearTimeout(tapTimer.current);
    clearTimeout(tapHold.current);
    clearInterval(hangupPoll.current);
    clearInterval(idlePoll.current);
    endAnnounce();
    toolsRunning.current = 0;
    responding.current = false;
    ws.current?.close();
    ws.current = null;
    stopPlayback();
    closeMic();
    worklet.current?.disconnect();
    ctx.current?.close();
    ctx.current = worklet.current = analyser.current = outBus.current = null;
    ready.current = false;
    thinking.current = false;
    asleepRef.current = false;
    setAsleep(false);
    setPhase("off");
    setLevels({ input: 0, output: 0 });
    setHearing(false);
  }, [stopPlayback]);
  stopRef.current = stop;

  /** Connect. `announce`: woken only to say what Claude finished (the mic stays closed for now). */
  const start = useCallback(async ({ announce = false }: { announce?: boolean } = {}) => {
    if (ws.current) return;
    setPhase("connecting");
    try {
      const ac = new AudioContext({ sampleRate: RATE });
      ctx.current = ac;
      if (ac.state === "suspended") void ac.resume();
      outBus.current = ac.createGain();
      analyser.current = ac.createAnalyser();
      analyser.current.fftSize = 512;
      outBus.current.connect(analyser.current);
      analyser.current.connect(ac.destination);
      if (announce) announceRef.current = { stage: "speaking", startedAt: Date.now(), ready: false, grace: false };
      else await openMic();
    } catch (e: any) {
      caption({ id: `err-${Date.now()}`, who: "error", text: `Microphone problem: ${e.message}` });
      stop();
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
      if (ws.current === sock) stop();
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
          : playing.current.size > 0
            ? "speaking"
            : thinking.current || (announceRef.current && announceRef.current.stage === "speaking") // spoken update: the mic is closed
              ? "thinking"
              : "listening",
      );
    }, 50);
    return () => clearInterval(id);
  }, [phase === "off"]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => stop, [stop]);

  /** Hotkey, orb click/right-click and "Hey Grok": start if asleep (hung up); otherwise go to sleep. */
  const hotkey = useCallback(() => {
    if (!ws.current) start();
    else if (asleepRef.current) wake(); // "one question" mode: a draft is waiting for your answer
    else sleep();
  }, [start, wake, sleep]);

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
    stop,
    /** Claude finished while Grok is off: connect just to say so, then listen ~3 s for a reply. */
    announce: () => {
      if (!ws.current) void start({ announce: true });
    },
    sleep: () => sleep(),
    wake,
    toggleSleep: hotkey,
    hotkey,
    sendText,
    ask,
    note: (text: string) => caption({ id: `note-${Date.now()}`, who: "note", text }),
    // Each names the exact draft it acts on, so a draft that changed meanwhile isn't sent.
    sendDraft: (id: number) => ws.current?.send(JSON.stringify({ type: "ui.send_draft", id })),
    discardDraft: (id: number) => ws.current?.send(JSON.stringify({ type: "ui.cancel_draft", id })),
    editDraft: (id: number, text: string) => ws.current?.send(JSON.stringify({ type: "ui.edit_draft", id, text })),
  };
}
