// Native encrypted single-key store. The crypto adapter is injected so tests never
// need Electron, a real Windows account, or the user's profile/credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createEncryptedKeyStore({ dir, name = 'xai-key.bin', safeStorage }) {
  const file = path.join(dir, name);
  const available = () => {
    try { return !!safeStorage.isEncryptionAvailable(); } catch { return false; }
  };
  const readState = () => {
    let sealed;
    try { sealed = fs.readFileSync(file); }
    catch (error) { return error?.code === 'ENOENT' ? { state: 'absent' } : { state: 'error', present: true }; }
    if (!available()) return { state: 'error', present: true };
    try {
      const key = safeStorage.decryptString(sealed);
      if (typeof key !== 'string') return { state: 'error', present: true };
      return key === '' ? { state: 'absent' } : { state: 'present', key };
    } catch { return { state: 'error', present: true }; }
  };
  return {
    kind: available() ? 'windows-dpapi' : 'unavailable',
    readState,
    // Existing xAI/Anthropic callers retain their old get/set interface.
    get() { const value = readState(); return value.state === 'present' ? value.key : ''; },
    set(key) {
      if (key === '') {
        try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw new Error('The saved key could not be removed. Try again.'); }
        return;
      }
      if (!available()) throw new Error('Windows encryption is not available, so the key was not saved.');
      let sealed;
      try { sealed = safeStorage.encryptString(key); }
      catch { throw new Error('Windows encryption failed, so the key was not saved.'); }
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, sealed, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
      } catch {
        throw new Error('The encrypted key could not be saved. Try again.');
      } finally {
        try { fs.unlinkSync(temporary); } catch {}
      }
    },
  };
}
