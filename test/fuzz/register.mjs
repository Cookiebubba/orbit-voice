// Loaded with `node --import ./test/fuzz/register.mjs`: swaps the modules that touch the real world
// (Claude's window, the real `claude` binary) for fakes, so fuzzing can never type into Claude,
// switch its session or spend money.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
