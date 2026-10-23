# "Stick to Claude Code" helper. Event-driven: Windows tells it the moment a Claude window moves,
# is minimized, closes, changes virtual desktop, or another window comes to the front.
#
# Claude can have several windows (the main one, sessions popped out into their own). This reports
# all of them; Orbit picks the one to dock on (the one most recently in front, see
# electron/claude-windows.js) and tells the helper which one to follow.
#
# It moves the orb itself, in the same instant, so the orb doesn't trail behind a dragged window.
# (Going through Orbit first would add a pipe and an IPC hop to every step.) It also prints one
# JSON line per change for Orbit, which handles showing, hiding and z-order:
#   {"wins":[{"hwnd":123,"min":false,"x":0,"y":0,"w":1200,"h":800},...],"fg":123,"front":"claude"|"orbit"|"other"}
# wins: Claude's windows, highest in z-order first. fg: the Claude window in front (0 if none).
# Coordinates are real screen pixels on every display (per-monitor DPI aware), excluding the
# invisible resize border.
#
# Commands from Orbit on stdin, one per line:
#   follow <orbHwnd> <claudeHwnd> <tl|tr|bl|br> <dx> <dy>   keep the orb at that spot on that window (DIPs)
#   pause                                                  stop moving the orb (it's hidden or being dragged)
#   box <claudeHwnd>                                       watch that window's prompt box (0: stop), for the avatar
#
# The prompt box (for the avatar, which stands on it): where it is, as UI Automation reports it, one
# line per change: {"box":{"hwnd":123,"rect":{"x":..,"y":..,"w":..,"h":..}|null,"win":{...}}} (rect
# and win in the same UI Automation space, so their ratio is right at any scaling). Only where it
# is: never what's in it. Read on its own thread, from a cached element (a fraction of a millisecond
# each), at once when the window moves or resizes, and otherwise every 150 ms while that Claude
# window is in front (the user typing, a sidebar opening) and every 1.5 s while it isn't. At most
# 40 reads a second (about 0.4 ms of CPU each), nothing while it's minimized or no avatar wants it.
# The helper exits when stdin closes (Orbit quit or crashed) or its parent process is gone.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$refs = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location)
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Windows;
using System.Windows.Automation;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
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
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetInt(IntPtr h, int attr, out int v, int size);

  const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_MINIMIZESTART = 0x0016, EVENT_SYSTEM_MINIMIZEEND = 0x0017;
  const uint EVENT_OBJECT_DESTROY = 0x8001, EVENT_OBJECT_SHOW = 0x8002, EVENT_OBJECT_HIDE = 0x8003;
  const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B, EVENT_OBJECT_CLOAKED = 0x8017, EVENT_OBJECT_UNCLOAKED = 0x8018;
  const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200;
  const uint GA_ROOTOWNER = 3;

  // Delegates kept in static fields so the garbage collector never frees a callback Windows still holds.
  static readonly WinEventProc onEvent = OnEvent;
  static readonly TimerProc onTimer = OnTimer;
  static readonly object gate = new object();

  static int parent;
  static uint[] pids = new uint[0];
  static IntPtr[] wins = new IntPtr[0]; // Claude's windows, highest in z-order first
  static uint[] hookedPids = new uint[0];
  static List<IntPtr> pidHooks = new List<IntPtr>();
  static string last = "";
  static int ticks;

  // The spot Orbit asked for (set from the stdin thread).
  static bool follow;
  static IntPtr orb = IntPtr.Zero;
  static IntPtr target = IntPtr.Zero; // the Claude window the orb is on
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

  static bool IsClaude(IntPtr h) { return Array.IndexOf(wins, h) >= 0; }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    events++;
    if (ev == EVENT_OBJECT_LOCATIONCHANGE) {
      if (idObject != 0 || !IsClaude(hwnd)) return; // only Claude's windows themselves, not carets etc.
      if (hwnd == boxHwnd) { winMoved = true; boxSignal.Set(); }
      if (hwnd == target) Reposition();
      Emit();
    } else if (ev == EVENT_OBJECT_DESTROY || ev == EVENT_OBJECT_SHOW || ev == EVENT_OBJECT_HIDE) {
      // A Claude window closed or hid, or a new top-level one appeared (not a menu or tooltip).
      if (idObject != 0) return;
      if (ev == EVENT_OBJECT_SHOW ? (GetAncestor(hwnd, 2) != hwnd || GetWindow(hwnd, 4) != IntPtr.Zero) : !IsClaude(hwnd)) return;
      Refind();
      Reposition();
      Emit();
    } else if (ev == EVENT_OBJECT_CLOAKED || ev == EVENT_OBJECT_UNCLOAKED) {
      Refind();
      Reposition();
      Emit();
    } else if (ev == EVENT_SYSTEM_MINIMIZESTART || ev == EVENT_SYSTEM_MINIMIZEEND) {
      if (!IsClaude(hwnd)) return;
      if (hwnd == boxHwnd) boxSignal.Set();
      if (hwnd == target) Reposition();
      Emit();
    } else {
      // Foreground changed. A Claude window not seen yet (just opened) is picked up now.
      IntPtr fg = GetAncestor(hwnd, GA_ROOTOWNER);
      if (fg != IntPtr.Zero && !IsClaude(fg) && Array.IndexOf(pids, Pid(fg)) >= 0) Refind();
      Emit();
    }
  }

  static void OnTimer(IntPtr h, uint msg, UIntPtr id, uint time) {
    if (parent != 0) {
      try { if (Process.GetProcessById(parent).HasExited) Environment.Exit(0); } catch (ArgumentException) { Environment.Exit(0); }
    }
    ticks++;
    if (wins.Length == 0 || (target != IntPtr.Zero && (!IsWindow(target) || Cloaked(target))) || ticks % 3 == 0) Refind();
    Reposition();
    Emit();
  }

  static void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] p = line.Trim().Split(' ');
      if (p[0] == "follow" && p.Length == 6 && (p[3] == "tl" || p[3] == "tr" || p[3] == "bl" || p[3] == "br")) {
        long o, w; double x, y;
        if (!long.TryParse(p[1], out o) || !long.TryParse(p[2], out w) || !double.TryParse(p[4], NumberStyles.Float, CultureInfo.InvariantCulture, out x) || !double.TryParse(p[5], NumberStyles.Float, CultureInfo.InvariantCulture, out y)) continue;
        lock (gate) { orb = new IntPtr(o); target = new IntPtr(w); corner = p[3]; dx = x; dy = y; follow = true; }
        Reposition();
      } else if (p[0] == "pause") {
        lock (gate) { follow = false; }
      } else if (p[0] == "box" && p.Length == 2) {
        long w;
        if (long.TryParse(p[1], out w)) WatchBox(new IntPtr(w));
      } else if (p[0] == "stats") {
        Out("{\"stats\":{\"reads\":" + reads + ",\"finds\":" + finds + ",\"events\":" + events + "}}");
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

  // Claude's windows: the visible, uncloaked, unowned, titled top-level windows of "claude"
  // processes, in z-order (EnumWindows goes from the top).
  static void Refind() {
    Process[] procs = Process.GetProcessesByName("claude");
    uint[] found = new uint[procs.Length];
    for (int i = 0; i < procs.Length; i++) found[i] = (uint)procs[i].Id;
    List<IntPtr> list = new List<IntPtr>();
    List<uint> owners = new List<uint>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid = Pid(h);
      if (Array.IndexOf(found, pid) < 0) return true;
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || GetWindowTextLength(h) == 0 || Cloaked(h)) return true;
      RECT r = Bounds(h);
      if (!IsIconic(h) && ((r.R - r.L) < 200 || (r.B - r.T) < 150)) return true; // not a real window (a pop-up strip)
      list.Add(h);
      if (!owners.Contains(pid)) owners.Add(pid);
      return true;
    }, IntPtr.Zero);
    pids = found;
    wins = list.ToArray();
    uint[] want = owners.ToArray();
    Array.Sort(want);
    if (!SameSet(want, hookedPids)) {
      // Move, close and desktop events only from Claude's processes, so other windows cost nothing.
      foreach (IntPtr hook in pidHooks) UnhookWinEvent(hook);
      pidHooks.Clear();
      foreach (uint pid in want) {
        pidHooks.Add(SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, IntPtr.Zero, onEvent, pid, 0, 0));
        pidHooks.Add(SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, onEvent, pid, 0, 0));
        pidHooks.Add(SetWinEventHook(EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED, IntPtr.Zero, onEvent, pid, 0, 0));
      }
      hookedPids = want;
    }
  }

  static bool SameSet(uint[] a, uint[] b) {
    if (a.Length != b.Length) return false;
    for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
    return true;
  }

  // Same rule as electron/orb-stick.js: a DIP distance from one corner, kept inside the window.
  static void Reposition() {
    IntPtr o, w; string c; double ax, ay;
    lock (gate) { if (!follow) return; o = orb; w = target; c = corner; ax = dx; ay = dy; }
    if (w == IntPtr.Zero || o == IntPtr.Zero || !IsWindow(o) || !IsWindow(w) || !IsClaude(w) || IsIconic(w)) return;
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
    IntPtr fgWin = GetForegroundWindow();
    IntPtr fgRoot = fgWin == IntPtr.Zero ? IntPtr.Zero : GetAncestor(fgWin, GA_ROOTOWNER);
    uint fgPid = Pid(fgWin);
    string front = Array.IndexOf(pids, fgPid) >= 0 ? "claude" : (parent != 0 && fgPid == (uint)parent ? "orbit" : "other");
    StringBuilder sb = new StringBuilder("{\"wins\":[");
    for (int i = 0; i < wins.Length; i++) {
      IntPtr h = wins[i];
      if (!IsWindow(h)) continue;
      RECT r = Bounds(h);
      if (sb[sb.Length - 1] == '}') sb.Append(',');
      sb.Append("{\"hwnd\":").Append(h.ToInt64()).Append(",\"min\":").Append(IsIconic(h) ? "true" : "false")
        .Append(",\"x\":").Append(r.L).Append(",\"y\":").Append(r.T).Append(",\"w\":").Append(r.R - r.L).Append(",\"h\":").Append(r.B - r.T).Append('}');
    }
    sb.Append("],\"fg\":").Append(IsClaude(fgRoot) ? fgRoot.ToInt64() : 0).Append(",\"front\":\"").Append(front).Append("\"}");
    string state = sb.ToString();
    if (state == last) return;
    last = state;
    Out(state);
  }

  static readonly object outGate = new object();
  static void Out(string line) {
    lock (outGate) {
      Console.Out.WriteLine(line);
      Console.Out.Flush();
    }
  }

  // ---------- the prompt box (see the top) ----------
  static volatile IntPtr boxHwnd = IntPtr.Zero; // the Claude window whose box is watched
  static readonly Stopwatch clock = Stopwatch.StartNew();
  static readonly AutoResetEvent boxSignal = new AutoResetEvent(false);
  static Thread boxThread;
  static AutomationElement boxEl, boxWinEl;
  static IntPtr boxElHwnd = IntPtr.Zero;
  static string lastBox = "";
  static long lastFind = -100000, lastRead = -100000, lastWinRead = -100000;
  static volatile bool winMoved = true; // the window moved or resized since its rect was read
  static long reads, finds, events; // for the stats command
  static Rect winRect = Rect.Empty;
  static readonly Condition promptCond = new AndCondition(
    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
    new PropertyCondition(AutomationElement.NameProperty, "Prompt"));

  static void WatchBox(IntPtr h) {
    boxHwnd = h;
    lastBox = "";
    if (boxThread == null && h != IntPtr.Zero) {
      boxThread = new Thread(BoxLoop);
      boxThread.IsBackground = true;
      boxThread.Start();
    }
    boxSignal.Set();
  }

  static bool InFront(IntPtr h) {
    IntPtr f = GetForegroundWindow();
    return f != IntPtr.Zero && GetAncestor(f, GA_ROOTOWNER) == h;
  }

  static void BoxLoop() {
    SetThreadDpiAwarenessContext(new IntPtr(-4)); // the same pixels as the window reports
    for (;;) {
      IntPtr h = boxHwnd;
      int wait = h == IntPtr.Zero ? Timeout.Infinite : !IsWindow(h) || IsIconic(h) ? 2000 : InFront(h) ? 150 : 1500;
      boxSignal.WaitOne(wait);
      h = boxHwnd;
      if (h == IntPtr.Zero || !IsWindow(h) || IsIconic(h)) continue;
      long since = clock.ElapsedMilliseconds - lastRead;
      if (since < 25) Thread.Sleep((int)(25 - since)); // at most 40 a second, however busy
      lastRead = clock.ElapsedMilliseconds;
      reads++;
      try { ReadBox(h); } catch (Exception) { boxEl = null; boxWinEl = null; }
    }
  }

  /** The prompt box in that window (in split view, the one with keyboard focus). */
  static AutomationElement FindBox(AutomationElement root) {
    AutomationElementCollection all = root.FindAll(TreeScope.Descendants, promptCond);
    if (all.Count == 0) return null;
    foreach (AutomationElement b in all) { try { if (b.Current.HasKeyboardFocus) return b; } catch (Exception) { } }
    return all[0];
  }

  static string RectJson(Rect r) {
    if (r.IsEmpty || r.Width <= 0 || r.Height <= 0) return "null";
    return "{\"x\":" + Math.Round(r.X) + ",\"y\":" + Math.Round(r.Y) + ",\"w\":" + Math.Round(r.Width) + ",\"h\":" + Math.Round(r.Height) + "}";
  }

  static void ReadBox(IntPtr h) {
    if (boxElHwnd != h) { boxEl = null; boxWinEl = null; boxElHwnd = h; winMoved = true; }
    if (boxWinEl == null) boxWinEl = AutomationElement.FromHandle(h);
    long now = clock.ElapsedMilliseconds;
    // The window's own rect only when it moved (or now and then): one read of the box is all a
    // keystroke costs.
    if (winMoved || winRect.IsEmpty || now - lastWinRead > 3000) {
      winMoved = false;
      lastWinRead = now;
      winRect = boxWinEl.Current.BoundingRectangle;
    }
    Rect win = winRect;
    Rect r = Rect.Empty;
    if (boxEl != null) { try { r = boxEl.Current.BoundingRectangle; } catch (ElementNotAvailableException) { boxEl = null; } }
    bool lost = boxEl == null || r.IsEmpty || r.Width <= 0 || r.Bottom < win.Top || r.Top > win.Bottom;
    // A lost box is looked for again (at most every 1.5 s: it's a search of Claude's whole page), and
    // now and then anyway while Claude is in front: another session's box is another element.
    if ((lost && now - lastFind > 1500) || (!lost && now - lastFind > 15000 && InFront(h))) {
      lastFind = now;
      finds++;
      AutomationElement b = FindBox(boxWinEl);
      if (b != null) { boxEl = b; r = b.Current.BoundingRectangle; } else if (lost) { boxEl = null; r = Rect.Empty; }
    }
    string s = "{\"box\":{\"hwnd\":" + h.ToInt64() + ",\"rect\":" + (boxEl == null ? "null" : RectJson(r)) + ",\"win\":" + RectJson(win) + "}}";
    if (s == lastBox) return;
    lastBox = s;
    Out(s);
  }
}
'@

[ClaudeFollow]::Run($ParentPid)
