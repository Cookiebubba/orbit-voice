// The engine oracle's voice cases (parity/oracle/gen.mjs), part one: what the voice is told and given
// (src/agent.js's instructions and tool definitions for each combination of the settings that shape
// them), the voice tools' own text checks (src/tools.js: fillers, a draft's words, the setting and
// switch asks, errors for the log, failure steps, the second brain's tool result; src/app-control.js's
// asks), and the Claude voice driver's text handling (src/claude-voice.js: the system prompt, words
// that go on, what may be said, the speech pieces, the tool calls Claude writes). Run on a Mac, where
// Orbit Native's settings apply; the Swift engine must give the same answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { corpus, randomUtterances } from './intent.mjs';

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const pick = (r, list) => list[Math.floor(r() * list.length)];

// Drafts and what was said, for the word checks.
const DRAFT_PAIRS = [
  ['Fix the failing tests.', 'tell it to fix the failing tests'],
  ['You forgot to update the README.', 'tell him he forgot to update the README'],
  ['Add a retry to the upload, like three times.', 'um, can you have it add a retry to the upload, like three times'],
  ['1. Run the tests.\n2. Fix what fails.\n3. Commit.', 'first run the tests, then fix what fails, then commit'],
  ['Add tests and refactor the database layer.', 'add tests'],
  ['Use `app.tsx`.', 'use app dot tsx'],
  ["Don't touch the config.", 'do not touch the config'],
  ['Ünïcode wörds', 'unicode words'],
  ['Make it faster, please.', 'make it faster'],
  ['', ''],
  ['It’s broken.', "it's broken"],
  ['10. Ten items', 'ten items'],
];
const BOX_PAIRS = [
  ['Fix the failing tests.', 'Fix the failing tests.'],
  ['Fix the failing tests now please.', 'Fix the failing tests.'],
  ['Something else entirely', 'Fix the failing tests.'],
  ['', 'x'],
  ['fix tests', 'Fix the failing tests and commit them all.'],
];
const FILLER_TEXTS = [
  'um fix it', 'Um, fix it', 'fix it, um.', 'uh so ummm yeah', 'ER is fine', 'UM stays', 'hmm. ok', 'line one\num line two', 'mmm good', 'ahh nice, uhh',
  'erm,', '  spaced   um   words  ', 'hm', 'uhm.', 'Ummm, uh, the thing.', 'a\n\num\n\nb',
];
const SETTING_CASES = [];
for (const [setting, values] of [['voice_model', ['haiku', 'sonnet', 'opus', 'fable', 'gpt']], ['volume', ['quieter', 'louder', '50', '50%', '100 percent', '101', 'x']]]) {
  for (const v of values) SETTING_CASES.push([setting, v]);
}
const SETTING_WORDS = [
  'use Opus', 'switch to Haiku', 'try sonnet', 'use opis', 'tell Claude to use Opus', "don't use Opus", 'switch Claude to Sonnet', 'set the model to Opus', 'set your voice to opus',
  'talk quieter', 'louder please', 'not so loud', "can't hear you", 'volume to 50', 'set the volume to 50%', 'turn it down', 'turn the volume up', 'speak up', 'keep it down', 'quiet',
  'use fable for your brain', 'run fabel', 'I want sonnet', "let's use haiku", 'haiku', 'volume 100', 'make it louder', "don't talk so loud",
];
const APP_ACTIONS = ['status', 'folders', 'sidebar', 'tab', 'panel', 'scroll', 'load_earlier', 'model', 'permission', 'rename', 'archive', 'delete', 'nope'];
const APP_WORDS = [
  'open the sidebar', 'hide the sidebar', 'switch to chat', 'show the terminal', 'scroll up', 'load earlier messages', 'switch Claude to Sonnet', 'use plan mode', 'accept edits',
  'rename this session to Login fix', 'archive this session', 'delete this session', "don't delete it", 'yes', 'what folders are there', 'show me the changes panel', 'scroll down a bit',
  'go to code', 'turn on bypass permissions', 'set permission mode to default', 'close the browser panel',
];
const ERRORS_FOR_LOG = ['', 'plain error', 'Not sent: the user\'s reply ("nope") says no.', 'No session matched "secret plans". Try list_sessions.', 'a “curly” quote', 'one "quote', null, 42, 'x'.repeat(400)];
const SEND_FAILURES = [
  null, {}, { error: 'send_button_not_found' }, { error: 'send_button_not_found', why: 'claude_working' }, { error: 'send_button_not_found', why: 'send_disabled', draftKept: false },
  { error: 'prompt_box_changed' }, { error: 'session_changed' }, { error: 'other', draftKept: false }, { error: 'other' },
];
const BRAIN_RESULTS = [
  [{ answer: 'Plain.', structured: null }, { label: 'Haiku' }],
  [{ answer: 'x', structured: { spoken: 'It is the cache.', details: 'More.', files: ['a.js:1'], suggested_prompt: 'Clear the cache', confidence: 'low' } }, { label: 'Opus', readProject: 'app' }],
  [{ answer: 'x', structured: { spoken: 'Yes.', details: '', files: [], suggested_prompt: '', confidence: 'high' } }, { label: 'Sonnet', note: 'It answered without reading files.' }],
  [{ answer: 'y', structured: { spoken: 'Maybe.', details: 'd', files: [], suggested_prompt: 'p', confidence: 'medium' } }, {}],
];

// What Claude writes for its tool calls, in every form the driver reads.
const CALLS = [
  '{"name": "get_current_session", "arguments": {}}', ' {"name":"draft_prompt","arguments":{"text":"Fix it."}} ', '{"name":"bad name","arguments":{}}', '{"name":"x","arguments":[1]}',
  '{"tool":"draft_prompt","text":"Fix it."}', '{"tool_name":"send_draft","parameters":{"a":1}}', '{"function":"go_to_sleep","input":{"x":true}}', 'not json', '', '[1,2]', '{"name": 5}',
  '<invoke name="draft_prompt"><parameter name="text">Fix the bug.</parameter></invoke>', '<invoke_draft_prompt><parameter name="text">Hi</parameter>',
  '<parameter name="draft_prompt"></parameter><parameter name="text">Hello there</parameter>', '<parameter name="get_current_session">{}</parameter>',
  '<tool_call><tool_name>send_draft</tool_name><parameters>{"a": 1}</parameters></tool_call>', '<tool_call><tool_name>list_sessions</tool_name></tool_call>',
  '<parse>{"name": "list_sessions", "arguments": {"limit": 3}}</parse>', '<tool_call>{"name":"read_session","arguments":{"session":"x"}}</tool_call>', '<function>{"tool":"go_to_sleep"}',
  '<draft_prompt>{"text": "Add tests."}</draft_prompt>', '<draft_prompt>{"arguments": {"text": "Nested."}}</draft_prompt>', '<invoke_tool>{"name": "send_draft", "arguments": {}}</invoke_tool>',
  '<invoke name="read_session"><parameter name="last_n">2</parameter><parameter name="include_tool_calls">true</parameter><parameter name="x">-1.5</parameter></invoke>',
  '<function_calls><invoke name="cancel_draft"></invoke></function_calls>', '<happy> Done!', '<invoke name="bad name!"></invoke>', '<tool_name>x</tool_name>', '<invoke_placeholder>',
];
const REPLIES = [
  'Sure.<tool>{"name": "get_current_session", "arguments": {}}</tool>', 'Let me check. <invoke name="list_sessions"></invoke>', 'No call here.', '<tool>broken</tool>', 'Hi <draft_prompt>{"text":"x"}</draft_prompt>',
];
const SPEAK_TEXTS = [
  'Hello **there**', 'See https://example.com/x now', 'HEAD~1 and a~b', '```code``` after', '# Title', 'a `b` c', '  many   spaces  ', '', 'The | pipe > quote', 'x_y_z', 'tilde ~ alone', 'ok~2',
];
const CHUNK_TEXTS = [
  'Hello there. How are you? Fine!', 'Short, but this clause goes on long enough to be cut at the comma, I think, yes.', 'One line\nTwo line\n', 'No end yet', 'e.g. this is. Fine',
  `${'word '.repeat(50)}end`, `${'x'.repeat(200)}`, 'A. B. C.', 'Hi, there', 'Wait — what; really: yes', '...', '!', 'a.', 'Mr. Smith went home.', '3.14 is pi. Yes.',
];
const UNFINISHED = ['and', 'tell Claude that I would like to', 'so, um', 'and also', 'fix the tests.', 'is it done?', 'I would like to be able to.', 'go on,', 'next…', 'well —', 'the', 'my', 'Fix it', '', 'cause', "can't"];

/** The settings that shape what the voice is told, in a spread of combinations (anywhere off). */
function contextSettings(r) {
  const out = [];
  const base = { anywhere: false };
  for (const avatar of ['qubit', 'buddy', 'none']) {
    for (const showOrb of [true, false]) out.push({ ...base, avatar, showOrb });
  }
  for (let i = 0; i < 20; i++) {
    out.push({
      ...base,
      avatar: pick(r, ['qubit', 'buddy', 'none']),
      showOrb: r() < 0.5,
      brainEnabled: r() < 0.6,
      brainModel: pick(r, ['auto', 'haiku', 'sonnet', 'opus']),
      brainExplore: r() < 0.5,
      brainConnection: pick(r, ['claude-code', 'api-key']),
      wakeOnResults: r() < 0.5,
      webSearch: r() < 0.5,
      voiceEngine: pick(r, ['grok', 'claude']),
    });
  }
  return out;
}

export async function voiceFixtures(root, rng) {
  const load = (...rel) => import(pathToFileURL(path.join(root, ...rel)).href);
  const config = await load('src', 'config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-oracle-voice-'));
  try {
    config.initConfig({ dir });
    const tools = await load('src', 'tools.js');
    const app = await load('src', 'app-control.js');
    const agent = await load('src', 'agent.js');
    const cv = await load('src', 'claude-voice.js');
    // A desktop shell with an avatar window (as Orbit Native is): the chosen avatar is the face.
    (await load('src', 'avatar-commands.js')).setAvatarSink(() => ({ ok: true }));
    const r = rng(777);
    const cases = [];
    const add = (fn, input, run) => {
      let output;
      try {
        output = plain(run());
      } catch (e) {
        output = { throws: String(e?.message || e) };
      }
      cases.push({ fn, input: plain(input), output });
    };

    const texts = (await corpus(root, r)).filter((_, i) => i % 3 === 0); // a third of the text corpus
    const more = randomUtterances(r, 200);
    for (const t of [...texts, ...FILLER_TEXTS, ...more]) add('removeFillers', t, () => tools.removeFillers(t));
    for (const t of [...texts, ...SETTING_WORDS, ...APP_WORDS]) {
      add('asksVerbatim', t, () => tools.asksVerbatim(t));
      add('asksSwitch', t, () => tools.asksFor('switch', t));
      add('asksDraft', t, () => tools.asksFor('draft', t));
    }
    for (const w of [...SETTING_WORDS, ...texts.slice(0, 150)]) for (const [s, v] of SETTING_CASES) add('asksSetting', { words: w, setting: s, value: v }, () => tools.asksSetting(w, s, v));
    for (const w of [...APP_WORDS, ...texts.slice(0, 120)]) for (const a of APP_ACTIONS) add('asksApp', { action: a, words: w, value: a === 'model' ? 'sonnet' : a === 'rename' ? 'Login fix' : '' }, () => app.asksApp(a, w, a === 'model' ? 'sonnet' : a === 'rename' ? 'Login fix' : ''));
    for (const [d, s] of DRAFT_PAIRS) {
      for (const direct of [false, true]) add('wordsNotSaid', { draft: d, said: s, direct }, () => tools.wordsNotSaid(d, s, { direct }));
    }
    for (let i = 0; i < 150; i++) {
      const d = pick(r, [...more, ...DRAFT_PAIRS.map((p) => p[0])]);
      const s = pick(r, [...more, ...DRAFT_PAIRS.map((p) => p[1])]);
      const direct = r() < 0.5;
      add('wordsNotSaid', { draft: d, said: s, direct }, () => tools.wordsNotSaid(d, s, { direct }));
    }
    for (const [b, d] of [...BOX_PAIRS, ...more.slice(0, 60).map((x, i) => [x, more[(i + 7) % 60]])]) add('isEditOf', { box: b, draft: d }, () => tools.isEditOf(b, d));
    for (const e of ERRORS_FOR_LOG) add('toolErrorForLog', e, () => tools.toolErrorForLog(e));
    for (const f of SEND_FAILURES) add('sendFailureStep', f, () => tools.sendFailureStep(f));
    for (const [res, o] of BRAIN_RESULTS) add('brainToolResult', { result: res, opts: o }, () => tools.brainToolResult(res, o));
    for (const t of [...UNFINISHED, ...texts.slice(0, 200)]) add('soundsUnfinished', t, () => cv.soundsUnfinished(t));
    for (const t of [...SPEAK_TEXTS, ...texts.slice(0, 200)]) add('speakableText', t, () => cv.speakableText(t));
    for (const t of [...CHUNK_TEXTS, ...more.slice(0, 80)]) {
      for (const first of [false, true]) for (const final of [false, true]) add('takeChunks', { buf: t, first, final }, () => cv.takeChunks(t, { first, final }));
    }
    for (const t of [...SPEAK_TEXTS, ...CHUNK_TEXTS, '_check', '="">', 'Paris.', 'OK.', '—', '  ', 'a', '😀', '<x>']) add('isJunk', t, () => cv.isJunk(t));
    for (const t of CALLS) {
      add('parseToolCall', t, () => cv.parseToolCall(t));
      add('parseXmlToolCall', t, () => cv.parseXmlToolCall(t));
    }
    for (const t of [...REPLIES, ...CALLS]) add('findToolCall', t, () => cv.findToolCall(t));

    // What the voice is told and given.
    const contexts = [];
    for (const s of contextSettings(r)) {
      config.updateSettings(s);
      const ctx = agent.agentContext();
      const all = config.getSettings();
      const settings = Object.fromEntries(['avatar', 'showOrb', 'brainEnabled', 'brainModel', 'brainExplore', 'brainConnection', 'wakeOnResults', 'webSearch', 'voiceEngine', 'anywhere'].map((k) => [k, all[k]]));
      contexts.push({ settings, context: plain(ctx), prompt: cv.systemPrompt({ instructions: ctx.instructions, tools: ctx.tools }) });
    }
    return { cases, contexts, contextSettings: agent.CONTEXT_SETTINGS };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
