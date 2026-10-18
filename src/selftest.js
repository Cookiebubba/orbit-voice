// Checks everything except the voice part: can we see your sessions and the Claude window?
//   npm run check                 -> read-only checks
//   npm run check -- --dry-paste  -> also pastes a test line into the prompt box, verifies it, and deletes it (never sends)
import { createToolRunner } from './tools.js';
import { sendToDesktop } from './desktop.js';

const tools = createToolRunner({ notify: () => {}, returnFocus: true });
const show = (label, obj) => console.log(`\n== ${label} ==\n${JSON.stringify(obj, null, 2).slice(0, 2500)}`);

show('list_sessions', await tools.run('list_sessions', '{"limit":5}'));
show('get_current_session', await tools.run('get_current_session', '{}'));

if (process.argv.includes('--dry-paste')) {
  show('dry-run paste (not sent)', await sendToDesktop('grok bridge self-test, safe to ignore', { dryRun: true }));
}
