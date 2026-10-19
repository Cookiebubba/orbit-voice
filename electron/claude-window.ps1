# Watches the Claude desktop window for "Stick to Claude Code". Prints one JSON line whenever its
# position, size, minimized state or the app in front changes, until Orbit exits.
#   {"found":false}
#   {"found":true,"hwnd":123,"min":false,"front":"claude"|"orbit"|"other","x":0,"y":0,"w":1200,"h":800}
# Coordinates are real screen pixels on every display (per-monitor DPI aware) and exclude the
# invisible resize border (DWM extended frame bounds). Orbit converts them with screenToDipRect.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClaudeWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmGetInt(IntPtr h, int attr, out int v, int size);

  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // Cloaked = on another virtual desktop (or otherwise hidden by DWM).
  public static bool Cloaked(IntPtr h) { int v; return DwmGetInt(h, 14, out v, 4) == 0 && v != 0; }
  public static RECT Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }
  // The main Claude window: the largest visible, uncloaked, unowned, titled top-level window of
  // the given processes (a minimized one only if nothing else qualifies).
  public static IntPtr Find(uint[] pids) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (Array.IndexOf(pids, Pid(h)) < 0) return true;
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || GetWindowTextLength(h) == 0 || Cloaked(h)) return true;
      RECT r = Bounds(h);
      long area = IsIconic(h) ? 1 : (long)(r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@

[void][ClaudeWin]::SetThreadDpiAwarenessContext([IntPtr](-4)) # per-monitor aware v2

$hwnd = [IntPtr]::Zero
$pids = [uint32[]]@()
$lastFind = -100000
$last = ''
$quiet = 0
$clock = [Diagnostics.Stopwatch]::StartNew()

while ($true) {
  $now = $clock.ElapsedMilliseconds
  $lost = $hwnd -ne [IntPtr]::Zero -and (-not [ClaudeWin]::IsWindow($hwnd) -or [ClaudeWin]::Cloaked($hwnd))
  if ($lost -or $now - $lastFind -ge 1500) {
    $lastFind = $now
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
    $pids = [uint32[]]@(Get-Process -Name 'claude' -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
    $hwnd = if ($pids.Count) { [ClaudeWin]::Find($pids) } else { [IntPtr]::Zero }
  }

  if ($hwnd -eq [IntPtr]::Zero) {
    $state = '{"found":false}'
  } else {
    $fg = [ClaudeWin]::GetForegroundWindow()
    $fgPid = [ClaudeWin]::Pid($fg)
    $front = if ($pids -contains $fgPid) { 'claude' } elseif ($ParentPid -and $fgPid -eq $ParentPid) { 'orbit' } else { 'other' }
    $min = if ([ClaudeWin]::IsIconic($hwnd)) { 'true' } else { 'false' }
    $r = [ClaudeWin]::Bounds($hwnd)
    $state = '{"found":true,"hwnd":' + $hwnd.ToInt64() + ',"min":' + $min + ',"front":"' + $front + '","x":' + $r.L + ',"y":' + $r.T + ',"w":' + ($r.R - $r.L) + ',"h":' + ($r.B - $r.T) + '}'
  }

  if ($state -ne $last) {
    [Console]::Out.WriteLine($state)
    [Console]::Out.Flush()
    $last = $state
    $quiet = 0
  } else {
    $quiet++
  }
  # Fast while things move (smooth following), slower once everything has been still for a second.
  Start-Sleep -Milliseconds $(if ($quiet -lt 30) { 30 } else { 100 })
}
