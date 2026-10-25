// Module resolve hook for the tool oracle (node --import parity/oracle/stand-ins/register.mjs):
// src/desktop.js and src/brain.js resolve to the oracle's recording stand-ins. The stand-in brain
// imports the real module with `?real` for its pure helpers.
const STAND_INS = {
  '/src/desktop.js': new URL('./desktop.mjs', import.meta.url).href,
  '/src/brain.js': new URL('./brain.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context);
  if (r.url.includes('?real')) return r;
  for (const [suffix, url] of Object.entries(STAND_INS)) if (r.url.endsWith(suffix)) return { url, shortCircuit: true };
  return r;
}
