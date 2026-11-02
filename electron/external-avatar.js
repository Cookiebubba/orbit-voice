// Fixed modes remain the legacy fallback. Roaming is optional and grants no execution authority.
export const ROAM_CAPABILITY = 'avatar.roam.v1';
export const AUTO_OWNER = 'external-auto';
export const MANAGED_OWNER = 'external-managed';
export function escapeAllowed(snapshot) {
  const p = snapshot?.avatarPlacement;
  return snapshot?.capabilities?.includes('avatar.containment.v1') === true && p?.schema === 1 && p?.allowEscape === true && Object.keys(p).length === 2;
}
export function supportsAutomatic(snapshot) {
  const p = snapshot?.avatarRoam;
  if (snapshot?.capabilities?.includes('avatar.containment.v1') && !escapeAllowed(snapshot)) return false;
  return snapshot?.capabilities?.includes(ROAM_CAPABILITY) === true && p?.schema === 1 && p?.policy === 'auto' &&
    Object.keys(p).length === 2;
}

export function createExternalAvatarSync({ binding, selected, getMode, setMode }) {
  let ready = false, latest = null;
  const sync = async (snapshot) => {
    if (!selected()) return false;
    latest = snapshot;
    if (!ready) return false;
    const managed = snapshot?.capabilities?.includes('avatar.containment.v1');
    const mode = supportsAutomatic(snapshot) ? 'auto' : managed ? 'attached' : snapshot?.mode;
    // A disconnected auto character retains its owner; a real fixed-policy snapshot overrides it.
    if (['desktop', 'attached', 'auto'].includes(mode) && getMode() !== mode) setMode(mode);
    return binding.sync(snapshot, getMode());
  };
  return { sync, initialize(snapshot = latest) { ready = true; return sync(snapshot); } };
}
export function createExternalAvatarBinding({ avatarHost, tracker, platform = process.platform }) {
  let generation = 0, latestStage = null, stageAt = 0, currentId = null, automatic = false, managed = false;
  const publish = (ctx, w = null) => {
    currentId = ctx.id;
    avatarHost.sync({ active: ctx, contexts: [{ ...ctx, native: w }] });
    if (w) avatarHost.onWins([w]);
    avatarHost.onStage?.(ctx.id, latestStage, stageAt);
  };
  const revoke = () => {
    if (managed) publish({ id: MANAGED_OWNER, managed: true, automatic, hwnd: 0, pid: null, stageEnabled: true });
    else if (automatic) publish({ id: AUTO_OWNER, automatic: true, hwnd: 0, pid: null, stageEnabled: true });
    else { currentId = null; avatarHost.sync({ active: { id: 'home' }, contexts: [] }); }
  };
  return {
    async sync(snapshot, mode) {
      const mine = ++generation;
      if (snapshot) managed = snapshot.capabilities?.includes('avatar.containment.v1') === true;
      automatic = platform === 'win32' && mode === 'auto' && (supportsAutomatic(snapshot) || !snapshot && automatic);
      if ((!automatic && mode !== 'attached') || platform !== 'win32' || !snapshot?.capabilities?.includes('avatar.attached') || !snapshot.window) {
        revoke(); return automatic;
      }
      const hwnd = Number(snapshot.window.handle), pid = Number(snapshot.window.pid);
      if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || !Number.isSafeInteger(pid) || pid <= 0) { revoke(); return false; }
      const w = await tracker()?.describe(hwnd);
      if (mine !== generation) return false;
      if (!w || w.hwnd !== hwnd || w.pid !== pid || w.kind !== 'app') { revoke(); return false; }
      const ctx = { id: managed ? MANAGED_OWNER : automatic ? AUTO_OWNER : `external-${snapshot.instanceId}`, managed, automatic, hwnd, pid, lastActiveAt: Date.now(), stageEnabled: snapshot.capabilities.includes('avatar.stage.v1'), instanceId: snapshot.instanceId, epoch: snapshot.window.epoch };
      publish(ctx, w);
      return true;
    },
    stage(value) { latestStage = value; stageAt = Date.now(); if (currentId) avatarHost.onStage?.(currentId, value, stageAt); },
    // Connection loss revokes only the region in Automatic. Explicit disable uses avatarHost settings.
    clear() { ++generation; latestStage = null; stageAt = 0; revoke(); },
  };
}
