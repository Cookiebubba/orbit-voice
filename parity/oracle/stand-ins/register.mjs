// node --import parity/oracle/stand-ins/register.mjs: the tool oracle's stand-ins (see loader.mjs).
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
