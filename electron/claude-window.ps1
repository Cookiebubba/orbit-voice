# "Stick to Claude Code" helper. Event-driven: Windows tells it the moment the Claude window moves,
# is minimized, changes virtual desktop, or another app comes to the front.
#
# It moves the orb itself, in the same instant, so the orb doesn't trail behind a dragged window.
# (Going through Orbit first would add a pipe and an IPC hop to every step.) It also prints one
# JSON line per change for Orbit, which handles showing, hiding and z-order:
#   {"found":false}
#   {"found":true,"hwnd":123,"min":false,"front":"claude"|"orbit"|"other","x":0,"y":0,"w":1200,"h":800}
# Coordinates are real screen pixels on every display (per-monitor DPI aware), excluding the
# invisible resize border.
#
# Commands from Orbit on stdin, one per line:
#   follow <orbHwnd> <tl|tr|bl|br> <dx> <dy>   keep the orb at that spot (dx, dy in DIPs)
#   pause                                     stop moving the orb (it's hidden or being dragged)
# The helper exits when stdin closes (Orbit quit or crashed) or its parent process is gone.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class ClaudeFollow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  public delegate void TimerProc(IntPtr hwnd, uint msg, UIntPtr id, uint time);
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr h, UIntPtr id, uint ms, TimerProc proc);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetInt(IntPtr h, int attr, out int v, int size);

  const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_MINIMIZESTART = 0x0016, EVENT_SYSTEM_MINIMIZEEND = 0x0017;
  const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B, EVENT_OBJECT_CLOAKED = 0x8017, EVENT_OBJECT_UNCLOAKED = 0x8018;
  const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200;

  // Delegates kept in static fields so the garbage collector never frees a callback Windows still holds.
  static readonly WinEventProc onEvent = OnEvent;
  static readonly TimerProc onTimer = OnTimer;
  static readonly object gate = new object();

  static int parent;
  static uint[] pids = new uint[0];
  static IntPtr claude = IntPtr.Zero;
  static uint hookedPid;
  static IntPtr[] pidHooks = new IntPtr[0];
  static string last = "";
  static int ticks;

  // The spot Orbit asked for (set from the stdin thread).
  static bool follow;
  static IntPtr orb = IntPtr.Zero;
  static string corner = "br";
  static double dx = 24, dy = 140;

  public static void Run(int parentPid) {
    parent = parentPid;
    SetThreadDpiAwarenessContext(new IntPtr(-4)); // per-monitor aware v2
    SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, onEvent, 0, 0, 0);
    SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, onEvent, 0, 0, 0);
    Refind();
    Emit();
    SetTimer(IntPtr.Zero, UIntPtr.Zero, 1000, onTimer); // safety net: re-find, notice exits
    Thread reader = new Thread(ReadCommands);
    reader.IsBackground = true;
    reader.Start();
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); }
  }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    if (ev == EVENT_OBJECT_LOCATIONCHANGE) {
      if (hwnd != claude || idObject != 0) return; // only the Claude window itself, not carets etc.
      Reposition();
      Emit();
    } else if (ev == EVENT_OBJECT_CLOAKED || ev == EVENT_OBJECT_UNCLOAKED) {
      Refind();
      Reposition();
      Emit();
    } else if (ev == EVENT_SYSTEM_MINIMIZEEND && hwnd == claude) {
      Reposition();
      Emit();
    } else {
      Emit(); // foreground changed, or Claude was minimized
    }
  }

  static void OnTimer(IntPtr h, uint msg, UIntPtr id, uint time) {
    if (parent != 0) {
      try { if (Process.GetProcessById(parent).HasExited) Environment.Exit(0); } catch (ArgumentException) { Environment.Exit(0); }
    }
    ticks++;
    if (claude == IntPtr.Zero || !IsWindow(claude) || Cloaked(claude) || ticks % 3 == 0) Refind();
    Reposition();
    Emit();
  }

  static void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] p = line.Trim().Split(' ');
      if (p[0] == "follow" && p.Length == 5 && (p[2] == "tl" || p[2] == "tr" || p[2] == "bl" || p[2] == "br")) {
        long h; double x, y;
        if (!long.TryParse(p[1], out h) || !double.TryParse(p[3], NumberStyles.Float, CultureInfo.InvariantCulture, out x) || !double.TryParse(p[4], NumberStyles.Float, CultureInfo.InvariantCulture, out y)) continue;
        lock (gate) { orb = new IntPtr(h); corner = p[2]; dx = x; dy = y; follow = true; }
        Reposition();
      } else if (p[0] == "pause") {
        lock (gate) { follow = false; }
      }
    }
    Environment.Exit(0); // Orbit closed our stdin: it quit or crashed
  }

  static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  static bool Cloaked(IntPtr h) { int v; return DwmGetInt(h, 14, out v, 4) == 0 && v != 0; }
  static RECT Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }

  // The main Claude window: the largest visible, uncloaked, unowned, titled top-level window of a
  // "claude" process (a minimized one only if nothing else qualifies).
  static void Refind() {
    Process[] procs = Process.GetProcessesByName("claude");
    uint[] found = new uint[procs.Length];
    for (int i = 0; i < procs.Length; i++) found[i] = (uint)procs[i].Id;
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (Array.IndexOf(found, Pid(h)) < 0) return true;
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || GetWindowTextLength(h) == 0 || Cloaked(h)) return true;
      RECT r = Bounds(h);
      long area = IsIconic(h) ? 1 : (long)(r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    pids = found;
    claude = best;
    uint pid = best == IntPtr.Zero ? 0 : Pid(best);
    if (pid != hookedPid) {
      // Move and desktop events only from Claude's process, so other windows cost nothing.
      foreach (IntPtr hook in pidHooks) UnhookWinEvent(hook);
      pidHooks = pid == 0 ? new IntPtr[0] : new IntPtr[] {
        SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, onEvent, pid, 0, 0),
        SetWinEventHook(EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED, IntPtr.Zero, onEvent, pid, 0, 0),
      };
      hookedPid = pid;
    }
  }

  // Same rule as electron/orb-stick.js: a DIP distance from one corner, kept inside the window.
  static void Reposition() {
    IntPtr o; string c; double ax, ay;
    lock (gate) { if (!follow) return; o = orb; c = corner; ax = dx; ay = dy; }
    IntPtr w = claude;
    if (w == IntPtr.Zero || o == IntPtr.Zero || !IsWindow(o) || IsIconic(w)) return;
    RECT cr = Bounds(w);
    RECT ob; GetWindowRect(o, out ob);
    int ow = ob.R - ob.L, oh = ob.B - ob.T;
    double s = GetDpiForWindow(w) / 96.0;
    if (s <= 0) s = 1;
    double x = c[1] == 'r' ? cr.R - ax * s - ow : cr.L + ax * s;
    double y = c[0] == 'b' ? cr.B - ay * s - oh : cr.T + ay * s;
    x = Clamp(x, cr.L, cr.R - cr.L, ow);
    y = Clamp(y, cr.T, cr.B - cr.T, oh);
    int ix = (int)Math.Round(x), iy = (int)Math.Round(y);
    if (ix != ob.L || iy != ob.T) SetWindowPos(o, IntPtr.Zero, ix, iy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  }

  static double Clamp(double v, int start, int length, int size) {
    if (length <= size) return start + (length - size) / 2.0;
    return Math.Min(Math.Max(v, start), start + length - size);
  }

  static void Emit() {
    string state;
    if (claude == IntPtr.Zero) {
      state = "{\"found\":false}";
    } else {
      uint fgPid = Pid(GetForegroundWindow());
      string front = Array.IndexOf(pids, fgPid) >= 0 ? "claude" : (parent != 0 && fgPid == (uint)parent ? "orbit" : "other");
      RECT r = Bounds(claude);
      state = "{\"found\":true,\"hwnd\":" + claude.ToInt64() + ",\"min\":" + (IsIconic(claude) ? "true" : "false") + ",\"front\":\"" + front + "\",\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}";
    }
    if (state == last) return;
    last = state;
    Console.Out.WriteLine(state);
    Console.Out.Flush();
  }
}
'@

[ClaudeFollow]::Run($ParentPid)
