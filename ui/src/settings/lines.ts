// Every line Qubit says out loud in Settings, by id. Spoken for real by Kitten on this computer
// (POST /api/claude-voice/preview), so each one is said in the voice and at the speed you chose. What's
// spoken can differ from the caption: captions show hotkey symbols, the voice says the key names.
// Caption-only moments (rooms opening, Grok, Chime only, Off, muted, a call in progress) have no line.

export const LINES = {
  // Voice room
  like: "Like this?",
  // Listening room
  listen_always: "I'll keep listening.",
  listen_one: "One question, then I rest.",
  // Never the wake phrase itself: said aloud with the wake word just turned on, it would wake him.
  wake_on: "Say my name any time. I hear it on {here}.",
  wake_off: "Hotkey only: {hotkey}.",
  half_on: "I won't listen while I talk.",
  half_off: "You can interrupt me.",
  hotkey_saved: "Saved. That's my new hotkey.",
  // Brain room
  vm: "I'll think with {model}.",
  eff_low: "I'll answer right away.",
  eff_medium: "I'll think a little longer.",
  eff_high: "I'll think longer before I speak.",
  stt_fastest: "Fastest. I'll hear you right away.",
  stt_balanced: "Balanced. Fewer misses when you mumble.",
  stt_accurate: "Accurate. I'll catch even a mumble.",
  brain_on: "I'll ask Claude when a question is hard.",
  brain_off: "I'll answer on my own.",
  bm_auto: "I'll pick the model.",
  bm: "Every question goes to {model}.",
  read_on: "Read only. Secret files stay blocked.",
  read_off: "I won't read the project.",
  web_on: "I can look things up. Pages never give me orders.",
  web_off: "No web search.",
  // When Claude finishes
  finished: "Claude finished billing. Tests pass.",
  wakesay_on: "I'll wake up to tell you.",
  wakesay_off: "I'll wait until you ask.",
  wakeready_on: "I'll wake when it's ready. At most 6 times an hour.",
  wakeready_off: "I'll stay asleep.",
  // Reach
  anywhere_on: "I can work in other windows. I ask before I send anything.",
  anywhere_off: "I'll stay in Claude's window.",
  see_on: "I'll send Claude a picture of one window when I need it.",
  see_off: "No pictures of your windows.",
  cdp_on: "I can use an app's own debugging port.",
  cdp_off: "I'll leave debugging ports alone.",
  mouse_on: "That's my mouse, in my colours.",
  mouse_off: "I'll move without a pointer of my own.",
  apps_add: "I ask before I send anything.",
  apps_remove: "I'll leave that one alone.",
  // Presence
  me: "That's me.",
  buddy: "The pixel buddy moves in.",
  noavatar: "Nothing on your Claude window.",
  size: "{size}. How's this?",
  clicktalk_on: "Click me to talk.",
  clicktalk_off: "Clicks won't wake me.",
  throw_off: "Feet on the ground.",
  wheee_off: "Quiet landings.",
  // App & updates
  update_on: "I'll update myself.",
  update_off: "Updates wait for you.",
  uptodate: "Up to date.",
  login_on: "I'll start when you sign in.",
  login_off: "I'll wait until you open me.",
  // A click on something switched off: what to turn on
  need_brain: "Turn on Second brain first.",
  need_anywhere: "Turn on Orbit anywhere first.",
  need_throw: "Turn on Throw first.",
  need_qubit: "That one's mine alone.",
  need_tells: "Turn on Orbit tells me first.",
  need_claude: "Switch to the Claude voice first.",
  need_avatar: "Pick an avatar first.",
} as const;

export type LineId = keyof typeof LINES;

/** A line with its {words} filled in. */
export const line = (id: LineId, fill: Record<string, string> = {}): string => LINES[id].replace(/\{(\w+)\}/g, (_m, k) => fill[k] ?? "");

const SPOKEN_KEYS: Record<string, string> = { CommandOrControl: "Control", Super: "Windows", Meta: "Windows", "-": "minus", "=": "equals", ",": "comma", ".": "period", "/": "slash" };
/** A hotkey as it's said: "Control Alt G", on a Mac "Command Option G". */
export const spokenHotkey = (accel: string, mac: boolean) =>
  accel
    .split("+")
    .filter(Boolean)
    .map((p) => (mac && p === "Alt" ? "Option" : mac && (p === "Super" || p === "Meta") ? "Command" : SPOKEN_KEYS[p] || p))
    .join(" ");
