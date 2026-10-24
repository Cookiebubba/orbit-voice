// The test chat app's page (built into slate-bundle.js by build.mjs): a Discord-like layout with a
// Slate.js message box (slate 0.146, slate-react 0.147, slate-history, React 19) and a React-
// controlled search box. Like Discord, the message box has no Send button: Enter sends, Shift+Enter
// is a new line. Slate keeps its own model and changes it only on input events (beforeinput), so the
// page reports the model itself (not the box's DOM text) to the test.
import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createEditor, Editor, Node, Transforms } from 'slate';
import { Slate, Editable, withReact } from 'slate-react';
import { withHistory } from 'slate-history';

const empty = () => [{ type: 'line', children: [{ text: '' }] }];
const textOf = (value) => value.map((n) => Node.string(n)).join('\n');

function App() {
  const editor = useMemo(() => withHistory(withReact(createEditor())), []);
  const [value, setValue] = useState(empty);
  const [search, setSearch] = useState('');
  const [sent, setSent] = useState([]);
  const [channel, setChannel] = useState('general');
  const model = textOf(value);

  useEffect(() => {
    const report = () =>
      window.chatApp?.report({
        model, // Slate's own model
        dom: (document.querySelector('[data-slate-editor]')?.innerText || '').replace(/﻿/g, '').replace(/\n$/, ''),
        search,
        sent,
        channel,
        focus: document.activeElement?.getAttribute('aria-label') || document.activeElement?.id || null,
        clicks: window.__clicks || 0,
        scrolled: Math.round(document.getElementById('messages')?.scrollTop || 0),
      });
    report();
    const t = setInterval(report, 250);
    return () => clearInterval(t);
  }, [model, search, sent, channel]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = textOf(editor.children);
        if (!text.trim()) return;
        setSent((s) => [...s, text]);
        Transforms.delete(editor, { at: { anchor: Editor.start(editor, []), focus: Editor.end(editor, []) } });
        Transforms.select(editor, Editor.start(editor, []));
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        Transforms.splitNodes(editor, { always: true });
      }
    },
    [editor],
  );

  const channels = ['general', 'random', 'orbit-tests'];
  return (
    <div className="app">
      <nav aria-label="Channels">
        <ul role="list" aria-label="Channels list">
          {channels.map((c) => (
            <li key={c}>
              <a href="#" aria-label={`${c} (text channel)`} aria-current={c === channel ? 'page' : undefined} onClick={(e) => (e.preventDefault(), setChannel(c), (window.__clicks = (window.__clicks || 0) + 1))}>
                # {c}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main>
        <header>
          <input aria-label="Search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button aria-label="Pinned Messages" onClick={() => (window.__clicks = (window.__clicks || 0) + 1)}>Pins</button>
          <button aria-label="Go forward" disabled>→</button>
        </header>
        <ol id="messages" aria-label={`Messages in ${channel}`}>
          {Array.from({ length: 30 }, (_, i) => (
            <li key={`old${i}`}>old message {i + 1}</li>
          ))}
          {sent.map((m, i) => (
            <li key={i} className="sent">
              {m}
            </li>
          ))}
        </ol>
        <form className="composer" onSubmit={(e) => e.preventDefault()}>
          <button type="button" aria-label="Upload a file">+</button>
          <Slate editor={editor} initialValue={value} onChange={setValue}>
            <Editable
              className="markup editor slateTextArea"
              aria-label={`Message #${channel}`}
              aria-multiline="true"
              aria-haspopup="listbox"
              aria-expanded="false"
              aria-autocomplete="list"
              placeholder={`Message #${channel}`}
              onKeyDown={onKeyDown}
              renderElement={({ attributes, children }) => <div {...attributes}>{children}</div>}
            />
          </Slate>
          <button type="button" aria-label="Send a gift">🎁</button>
          <button type="button" aria-label="Open GIF picker">GIF</button>
          <button type="button" aria-label="Add Emoji">☺</button>
        </form>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
