// Test-only transport: consent logic stays real, but no sandbox run may write to
// the user's OS clipboard or launch a clipboard helper.
import { MAX_CLIPBOARD_CHARS } from '../../src/clipboard.js?real';
export { MAX_CLIPBOARD_CHARS };
let writer = null;
export function setClipboardWriter(fn) { writer = typeof fn === 'function' ? fn : null; }
export async function writeClipboard(text) {
  const value = String(text ?? '');
  if (!value) return { ok: false, error: 'Nothing to copy.' };
  if (value.length > MAX_CLIPBOARD_CHARS) return { ok: false, error: `That's over ${MAX_CLIPBOARD_CHARS} characters, too long to copy.` };
  if (writer) writer(value);
  else globalThis.__fuzz?.calls?.push({ name: 'copy', args: { text: value } });
  return { ok: true, chars: value.length };
}
