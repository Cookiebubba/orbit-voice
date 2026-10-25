// Module resolve hook for the engine oracle's children (node --import parity/oracle/stand-ins/register.mjs):
// src/desktop.js, src/brain.js and src/claude-voice.js resolve to the oracle's recording stand-ins,
// and the `ws` package to one without sockets. A stand-in imports its real module with `?real` for
// the pure helpers.
const STAND_INS = {
  '/src/desktop.js': new URL('./desktop.mjs', import.meta.url).href,
  '/src/brain.js': new URL('./brain.mjs', import.meta.url).href,
  '/src/claude-voice.js': new URL('./claude-voice.mjs', import.meta.url).href,
};
const WS = new URL('./ws.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context);
  if (r.url.includes('?real')) return r;
  for (const [suffix, url] of Object.entries(STAND_INS)) if (r.url.endsWith(suffix)) return { url, shortCircuit: true };
  if (/\/node_modules\/ws\//.test(r.url)) return { url: WS, shortCircuit: true };
  return r;
}
