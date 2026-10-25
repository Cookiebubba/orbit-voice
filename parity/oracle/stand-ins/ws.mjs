// The relay oracle's stand-in for the `ws` package: no sockets. A WebSocketServer hands its
// connection listener to the oracle (which plays the page), and every WebSocket the core opens (to
// xAI) is recorded and played by the oracle's script (parity/oracle/relay.mjs).
import { EventEmitter } from 'node:events';

const o = () => globalThis.__relay;

export class WebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, opts = {}) {
    super();
    this.readyState = 0;
    o().upstreamCreated(this, { kind: 'grok', url: String(url), auth: opts?.headers?.Authorization ? 'Bearer KEY' : null });
  }

  send(data) {
    o().upstreamSent(this, String(data));
  }

  close(code, reason) {
    o().upstreamClosed(this, code ?? null, reason ?? null);
  }
}

export class WebSocketServer extends EventEmitter {
  constructor(opts = {}) {
    super();
    o().wss = this;
    o().wssOptions = { path: opts.path, maxPayload: opts.maxPayload };
  }
}

export default WebSocket;
