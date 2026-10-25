// The Node core's own audio path (src/claude-voice.js createClaudeRealtime: resample, VAD, lead-in,
// speech to text) on the parity clips, fed as the page feeds it (100 ms PCM16 chunks), with a silent
// stand-in for Claude Code. The reference for LocalSpeechListener:
//   node engine-reference.mjs <models> <clips dir> <out.json>
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const [models, clips, out] = process.argv.slice(2);
const { createClaudeRealtime, loadSpeech } = await import(pathToFileURL(path.join(ROOT, 'src', 'claude-voice.js')).href);
const speech = await loadSpeech(models);

// Claude Code that never answers (only the listening is being compared).
const spawnImpl = () => {
  const c = new EventEmitter();
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kill = () => c.emit('close', 0);
  return c;
};

const result = {};
for (const f of fs.readdirSync(clips).filter((x) => x.endsWith('.wav')).sort()) {
  const pcm = fs.readFileSync(path.join(clips, f)).subarray(44);
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl });
  const ev = [];
  sock.on('message', (d) => ev.push(JSON.parse(d)));
  await new Promise((r) => sock.once('open', r));
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  const chunk = 2400 * 2; // 100 ms at 24 kHz
  for (let i = 0; i < pcm.length; i += chunk) sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(i, i + chunk).toString('base64') }));
  const until = Date.now() + 8000;
  while (!ev.some((e) => e.type === 'conversation.item.input_audio_transcription.completed') && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  result[f] = {
    started: ev.filter((e) => e.type === 'input_audio_buffer.speech_started').length,
    transcripts: ev.filter((e) => e.type === 'conversation.item.input_audio_transcription.completed').map((e) => e.transcript),
    endedMsAgo: ev.filter((e) => e.type === 'input_audio_buffer.speech_stopped').map((e) => e.ended_ms_ago),
  };
  sock.close();
}
fs.writeFileSync(out, JSON.stringify(result));
process.exit(0);
