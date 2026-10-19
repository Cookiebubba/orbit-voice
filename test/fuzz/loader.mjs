// Module resolve hook (see register.mjs). `src/desktop.js` and `src/brain.js` resolve to fakes; the
// fakes import the real brain.js with `?real` to reuse its pure helpers.
const FAKES = {
  '/src/desktop.js': new URL('./fake-desktop.mjs', import.meta.url).href,
  '/src/brain.js': new URL('./fake-brain.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context);
  if (r.url.includes('?real')) return r;
  for (const [suffix, fake] of Object.entries(FAKES)) {
    if (r.url.endsWith(suffix)) return { url: fake, shortCircuit: true };
  }
  return r;
}
