// A stand-in for Orbit's macOS helper ("ax" mode) looking at the Claude app: a Claude window whose
// accessibility tree has the shape the real one has on macOS (seen read-only on the live app,
// 2026-10: Chromium's AXGroup for every div, the sidebar a complementary landmark named "Sidebar",
// session rows with their "More options for <title>" one level deeper, the prompt box a ProseMirror
// AXTextArea named "Prompt", Send / Stop on its row). It answers windows / scan / act / raise as the
// helper does and changes like Claude would when its buttons are pressed.

const T = {
  Window: 'AXWindow',
  Document: 'AXWebArea',
  Group: 'AXGroup',
  Button: 'AXButton',
  Edit: 'AXTextArea',
  Text: 'AXStaticText',
  RadioButton: 'AXRadioButton',
  MenuItem: 'AXMenuItem',
};

/** A Claude app with sessions, one window, and what's on its page. */
export function createFakeClaude({ sessions = ['Fix the login bug', 'Write the release notes', 'Plan viewer alpha'], open = 'Fix the login bug', folders = [['Fire', 'ladder 6'], ['orbit-voice', '']], working = false, card = null, hwnd = 359, minimized = false } = {}) {
  const state = {
    sessions: [...sessions],
    open, // the open session's title, or null for a new session
    newFolder: null, // a new session's folder
    box: '',
    working,
    card, // { kind: 'permission', title, command, buttons: [...] } | { kind: 'question', question, options: [...], multi }
    sent: [],
    pressed: [],
    sidebar: true,
    model: 'Opus 5.5 High',
    menu: null, // 'model' while its menu is open
    raised: 0,
    boxSetCalls: 0,
    rejectSetValue: false,
    folders,
  };

  let next = 0;
  const node = (t, props = {}, kids = []) => ({ t, ...props, kids });
  const btn = (name, props = {}) => node('Button', { n: name, pat: 'I', ...props });

  function build() {
    const sidebar = node('Group', { n: 'Sidebar', sr: 'AXLandmarkComplementary', r: [0, 40, 280, 1000] }, [
      btn(state.sidebar ? 'Hide sidebar' : 'Show sidebar'),
      node('Group', { n: 'Mode', role: 'AXRadioGroup' }, [node('RadioButton', { n: 'Claude', sel: 0, pat: 'IS' }), node('RadioButton', { n: 'Code', sel: 1, pat: 'IS' })]),
      node('Group', { c: 'dframe-sidebar-body' }, [
        node('Group', { c: 'dframe-nav-scroll' }, [
          btn('New', { c: 'w-full shrink-0' }),
          btn('Routines'),
          ...state.folders.map(([folder, group]) =>
            node('Group', { c: 'group/section' }, [node('Group', { c: 'group/labelrow' }, [btn(`New session in ${folder}${group ? `, added to ${group}` : ''}`)])]),
          ),
          ...state.sessions.map((s) =>
            node('Group', { c: 'relative df-drag-shiftable' }, [
              node('Group', { c: 'group hit-row' }, [btn(`${s} Cloud`, { c: 'w-full shrink-0' }, []), node('Group', { c: 'absolute end-0' }, [btn(`More options for ${s}`, { role: 'AXPopUpButton', pat: 'IE' })])]),
            ]),
          ),
        ]),
      ]),
    ]);
    const header = state.open
      ? [node('Group', { c: 'epitaxy-titlebar' }, [btn(`${state.open}, rename session`), btn(`More options for ${state.open}`, { role: 'AXPopUpButton', pat: 'IE' }), btn('Changes', { role: 'AXCheckBox', sr: 'AXToggle', tog: 0, pat: 'IT' })])]
      : [node('Group', {}, [node('Text', { n: 'New session', role: 'AXStaticText', r: [600, 300, 120, 20] })])];
    const cards = [];
    if (state.card?.kind === 'permission') {
      cards.push(
        node('Group', { c: 'epitaxy-approval-card rounded' }, [
          node('Group', {}, [node('Text', { n: state.card.title })]),
          node('Group', { n: 'The command Claude wants to run' }, [node('Text', { n: state.card.command })]),
          node('Group', { c: 'flex gap' }, (state.card.buttons || ['Allow once', 'Always allow', 'Deny']).map((b) => btn(b))),
        ]),
      );
    } else if (state.card?.kind === 'question') {
      cards.push(
        node('Group', { n: state.card.question, c: 'epitaxy-approval-card epitaxy-question-card' }, [
          ...state.card.options.map((o, k) => btn(o, { role: 'AXCheckBox', sr: 'AXToggle', c: 'epitaxy-answer-option', tog: state.card.picked === k ? 1 : 0, pat: 'IT' }, [])),
          btn('Skip'),
          btn('Submit', { en: state.card.picked === undefined ? 0 : 1 }),
          ...(state.card.multi ? [] : [node('Group', { c: 'epitaxy-radio-mark' })]),
        ]),
      );
    }
    const composer = node('Group', { c: 'composer' }, [
      node('Edit', { n: 'Prompt', c: 'tiptap ProseMirror', v: state.box || '\n', r: [400, 1000, 420, 21], pat: 'VIX', rich: 1, foc: 1 }),
      node('Group', { c: 'absolute bottom-0 end-0' }, [state.working ? btn('Stop', { r: [828, 996, 28, 28] }) : btn('Send', { r: [828, 996, 28, 28], en: state.box ? 1 : 0 })]),
      btn(`Model: ${state.model}`, { role: 'AXPopUpButton', pat: 'IE', exp: state.menu === 'model' ? 1 : 0 }),
      btn('Bypass permissions', { role: 'AXPopUpButton', pat: 'IE' }),
      ...(state.open ? [] : [btn(`Folder: ${state.newFolder || 'orbit-voice'}`)]),
    ]);
    const menu = state.menu === 'model' ? [node('Group', { role: 'AXMenu' }, ['Opus 5.5', 'Opus 5.5 High', 'Sonnet 5.5', 'Haiku 5.5'].map((m) => node('MenuItem', { n: m, pat: 'I' })))] : [];
    const doc = node('Document', { n: state.open ? `${state.open} - Claude Code` : 'Claude', r: [0, 40, 1200, 1000] }, [
      node('Group', { c: 'dframe-root' }, [
        ...(state.sidebar ? [sidebar] : [btn('Show sidebar')]),
        node('Group', { sr: 'AXLandmarkMain' }, [...header, node('Group', { n: 'Chat messages', sr: 'AXApplicationGroup' }, [node('Group', { sr: 'AXDocumentArticle', n: 'Message 1' }, [node('Text', { n: 'An earlier message.' })])]), node('Group', { c: 'group/approval-dock' }, [...cards, composer]), ...menu]),
      ]),
    ]);
    return node('Window', { n: 'Claude', role: 'AXWindow', sr: 'AXStandardWindow', r: [0, 0, 1200, 1040] }, [node('Group', { c: 'RootView' }, [node('Document', { r: [0, 0, 1, 1] }, []), doc])]);
  }

  /** The tree as the helper's scan reports it (depth-first, parents first). */
  function flatten(skip = []) {
    next = 0;
    const out = [];
    const walk = (n, p) => {
      const i = next++;
      const { kids, ...rest } = n;
      const role = rest.role || T[rest.t] || 'AXGroup';
      out.push({ i, p, en: 1, ...rest, role, rid: `rid-${i}-${rest.n || rest.t}` });
      if (skip.includes(rest.n)) return;
      for (const k of kids) walk(k, i);
    };
    walk(build(), -1);
    return out;
  }

  let last = [];
  const ok = (o) => ({ ok: true, ...o });

  function act({ i, action, value }) {
    const n = last[i];
    if (!n) return { ok: false, error: 'stale' };
    if (n.en === 0) return { ok: false, error: 'disabled' };
    const name = String(n.n || '');
    state.pressed.push(`${action}:${name}`);
    if (action === 'set_text') {
      if (name === 'Prompt') {
        state.boxSetCalls++;
        if (!state.rejectSetValue) state.box = String(value);
        return ok({ via: 'ax-value', verified: !state.rejectSetValue });
      }
      return ok({ via: 'ax-value', verified: true });
    }
    if (action === 'focus' || action === 'show') return ok({ via: 'ax-focus' });
    if (action === 'expand' && name.startsWith('Model: ')) {
      state.menu = 'model';
      return ok({ via: 'ax-press' });
    }
    if (action === 'collapse') {
      state.menu = null;
      return ok({ via: 'ax-cancel' });
    }
    if (n.t === 'MenuItem' && state.menu === 'model') {
      state.model = name;
      state.menu = null;
      return ok({ via: 'ax-press' });
    }
    if (name === 'Send') {
      state.sent.push(state.box);
      if (!state.open) {
        state.open = state.box.slice(0, 30);
        state.sessions.unshift(state.open);
      }
      state.box = '';
      state.working = true;
      return ok({ via: 'ax-press' });
    }
    if (name === 'Stop') {
      state.working = false;
      return ok({ via: 'ax-press' });
    }
    if (name === 'New') {
      state.open = null;
      state.newFolder = 'orbit-voice';
      return ok({ via: 'ax-press' });
    }
    if (name.startsWith('New session in ')) {
      state.open = null;
      state.newFolder = name.slice('New session in '.length).split(', added to ')[0];
      return ok({ via: 'ax-press' });
    }
    if (name === 'Hide sidebar' || name === 'Show sidebar') {
      state.sidebar = !state.sidebar;
      return ok({ via: 'ax-press' });
    }
    if (state.card?.kind === 'permission' && ['Allow once', 'Always allow', 'Deny', 'Allow for this session'].includes(name)) {
      state.answer = name;
      state.card = null;
      return ok({ via: 'ax-press' });
    }
    if (state.card?.kind === 'question') {
      const k = state.card.options.indexOf(name);
      if (k >= 0) {
        state.card.picked = k;
        return ok({ via: 'ax-press' });
      }
      if (name === 'Submit' || name === 'Skip') {
        state.answer = name === 'Skip' ? 'skip' : state.card.options[state.card.picked];
        state.card = null;
        return ok({ via: 'ax-press' });
      }
    }
    const row = state.sessions.find((s) => name === `${s} Cloud`);
    if (row) {
      if (!state.box) state.open = row; // (Claude switches; a draft would stay with its session)
      else state.open = row;
      return ok({ via: 'ax-press' });
    }
    return ok({ via: 'ax-press' });
  }

  return {
    state,
    hwnd,
    request(op, args = {}) {
      switch (op) {
        case 'windows':
          return Promise.resolve(ok({ running: true, windows: [{ hwnd, pid: 4242, title: 'Claude', min: minimized, onscreen: !minimized, sr: 'AXStandardWindow', x: 0, y: 0, w: 1200, h: 1040, focused: true, z: 0 }] }));
        case 'scan':
          if (args.hwnd !== hwnd) return Promise.resolve({ ok: false, error: 'no_window' });
          last = flatten(args.skip || []);
          return Promise.resolve(ok({ fw: 'Chrome', nodes: last, truncated: false }));
        case 'act':
          if (args.hwnd !== hwnd) return Promise.resolve({ ok: false, error: 'no_window' });
          return Promise.resolve(act(args));
        case 'raise':
          state.raised++;
          return Promise.resolve(ok({ switched: true, how: 'foreground' }));
        default:
          return Promise.resolve({ ok: false, error: 'bad_request' });
      }
    },
  };
}
