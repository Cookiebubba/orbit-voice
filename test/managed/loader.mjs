// Acceptance-only import seams. Production main/server/renderers are not replaced.
import { resolve as fuzzResolve } from '../fuzz/loader.mjs';
const realServer = new URL('../../src/server.js?managed-acceptance-real', import.meta.url).href;
const realCredentials = new URL('../../electron/openai-credentials.js?managed-acceptance-real', import.meta.url).href;
const fixture = new URL('./provider.mjs', import.meta.url).href;
const data = (source) => ({ url: `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`, shortCircuit: true });
export async function resolve(specifier, context, nextResolve) {
  const found = await nextResolve(specifier, context);
  if (found.url.includes('?managed-acceptance-real')) return found;
  if (found.url.endsWith('/electron/preview-runtime.js')) return data('export const checkStandaloneConflict = async () => false;'); // never contact a user-owned standalone port
  if (found.url.endsWith('/src/server.js')) return data(`
    export * from ${JSON.stringify(realServer)};
    import { startServer as real } from ${JSON.stringify(realServer)};
    import { realtimeFactory, credentials } from ${JSON.stringify(fixture)};
    export const startServer = (options) => real({ ...options, realtimeFactory, openaiCredentials: credentials() });
  `);
  if (found.url.endsWith('/electron/openai-credentials.js')) return data(`
    export * from ${JSON.stringify(realCredentials)};
    import { credentials } from ${JSON.stringify(fixture)};
    export const createOpenAICredentials = credentials;
  `);
  return fuzzResolve(specifier, context, nextResolve);
}
