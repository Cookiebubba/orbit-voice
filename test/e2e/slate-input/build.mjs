// Rebuilds slate-bundle.js from editor.jsx (only needed when editor.jsx changes; the bundle is kept
// in the repo so tests need no extra packages). Needs a folder with these installed:
//   npm i slate@0.146.0 slate-react@0.147.3 slate-history@0.144.0 react@19.3.1 react-dom@19.3.1
//   node test/e2e/slate-input/build.mjs <that folder>
// esbuild comes from ui/node_modules. All bundled packages are MIT licensed.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(process.argv[2] || '.');
const esbuild = createRequire(path.join(here, '..', '..', '..', 'ui', 'package.json'))('esbuild');
await esbuild.build({
  entryPoints: [path.join(here, 'editor.jsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'chrome120',
  jsx: 'automatic',
  nodePaths: [path.join(from, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: '/* Test fixture: slate 0.146.0, slate-react 0.147.3, slate-history 0.144.0, react 19.3.1 (all MIT). Built by build.mjs from editor.jsx. */' },
  outfile: path.join(here, 'slate-bundle.js'),
  logLevel: 'info',
});
