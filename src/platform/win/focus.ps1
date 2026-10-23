# "Orbit anywhere" focus helper: follows which window is in front, in any app, without polling.
# Windows tells it the moment the foreground window changes (SetWinEventHook, out of context: no
# code goes into any other app), when a window is minimized or restored, when Alt+Tab starts and
# ends, and when the window in front changes its title. Long-lived; one JSON object per line.
#
# Reports (stdout):
#   {"fg":<win>}                       the window in front changed (or its title, or minimized)
#   {"switching":true|false}           Alt+Tab (or Win+Tab) started / ended
#   {"gone":[hwnd,...]}                windows reported before that no longer exist
#   {"id":n,"describe":<win>|null}     answer to "describe"
#   {"id":n,"list":[<win>,...]}        answer to "list": the app windows Alt+Tab would show, front first
# <win> = {"hwnd","owner","pid","exe","title","cls","kind","min","max","cloaked","elevated","x","y","w","h","dpi"}
#   hwnd: the top-level window; owner: its root owner when it's an owned window (a dialog), else 0.
#   kind: "app" (an ordinary app window) | "orbit" (one of Orbit's own) | "shell" (taskbar, desktop,
#   Start, Alt+Tab, lock screen) | "none" (nothing in front).
#   x/y/w/h: real screen pixels without the invisible resize border (per-monitor DPI aware).
#   elevated: the app runs as administrator (or as another user), so Windows blocks Orbit from it.
# The title is the app's own text: it never goes to the log (see focus.js).
#
# Commands (stdin): "describe <id> <hwnd>", "list <id>", "quit".
# Exits when stdin closes or its parent process (Orbit) is gone.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OrbitFocus {
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
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr h, UIntPtr id, uint ms, TimerProc proc);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetInt(IntPtr h, int attr, out int v, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int size, out int ret);

  const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_SWITCHSTART = 0x0014, EVENT_SYSTEM_SWITCHEND = 0x0015;
  const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016, EVENT_SYSTEM_MINIMIZEEND = 0x0017, EVENT_OBJECT_NAMECHANGE = 0x800C;
  const uint WINEVENT_OUTOFCONTEXT = 0, WINEVENT_SKIPOWNPROCESS = 2;
  const uint GA_ROOT = 2, GA_ROOTOWNER = 3, GW_OWNER = 4;
  const int GWL_EXSTYLE = -20; const long WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
  const uint WM_QUIT = 0x0012;

  static readonly WinEventProc onEvent = OnEvent; // kept in a field so it is never collected
  static readonly TimerProc onTimer = OnTimer;
  static readonly object outGate = new object();
  static uint parent;
  static uint loopThread;
  static IntPtr fgRoot = IntPtr.Zero;
  static IntPtr nameHook = IntPtr.Zero; static uint nameHookPid;
  static string lastFg = "";
  static readonly List<IntPtr> seen = new List<IntPtr>(); // app windows reported, to say when they go

  static readonly HashSet<string> ShellClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW", "MultitaskingViewFrame", "XamlExplorerHostIslandWindow",
    "ForegroundStaging", "TaskSwitcherWnd", "TaskListThumbnailWnd", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland",
    "Shell_InputSwitchTopLevelWindow", "Windows.UI.Input.InputSite.WindowClass" };
  static readonly HashSet<string> ShellExes = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "SearchHost.exe", "SearchApp.exe", "StartMenuExperienceHost.exe", "ShellExperienceHost.exe", "LockApp.exe", "LogonUI.exe",
    "Widgets.exe", "TextInputHost.exe", "ShellHost.exe" };

  public static void Run(int parentPid) {
    parent = (uint)parentPid;
    loopThread = GetCurrentThreadId();
    SetThreadDpiAwarenessContext(new IntPtr(-4)); // per-monitor aware v2: real pixels on every display
    SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, onEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    SetWinEventHook(EVENT_SYSTEM_SWITCHSTART, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, onEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    Foreground(GetForegroundWindow());
    SetTimer(IntPtr.Zero, UIntPtr.Zero, 1000, onTimer); // safety net: a missed event, closed windows, Orbit gone
    Thread reader = new Thread(ReadCommands);
    reader.IsBackground = true;
    reader.Start();
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); }
  }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    try {
      if (ev == EVENT_SYSTEM_FOREGROUND) { Foreground(hwnd); return; }
      if (ev == EVENT_SYSTEM_SWITCHSTART || ev == EVENT_SYSTEM_SWITCHEND) { Out("{\"switching\":" + (ev == EVENT_SYSTEM_SWITCHSTART ? "true" : "false") + "}"); return; }
      if (ev == EVENT_SYSTEM_MINIMIZESTART || ev == EVENT_SYSTEM_MINIMIZEEND) { if (GetAncestor(hwnd, GA_ROOT) == fgRoot) Foreground(GetForegroundWindow()); return; }
      if (ev == EVENT_OBJECT_NAMECHANGE && idObject == 0 && hwnd == fgRoot) Foreground(GetForegroundWindow());
    } catch (Exception) { }
  }

  static void OnTimer(IntPtr h, uint msg, UIntPtr id, uint time) {
    if (parent != 0) {
      try { if (Process.GetProcessById((int)parent).HasExited) Environment.Exit(0); } catch (ArgumentException) { Environment.Exit(0); }
    }
    try {
      Foreground(GetForegroundWindow());
      List<long> gone = new List<long>();
      for (int i = seen.Count - 1; i >= 0; i--) if (!IsWindow(seen[i])) { gone.Add(seen[i].ToInt64()); seen.RemoveAt(i); }
      if (gone.Count > 0) Out("{\"gone\":[" + string.Join(",", gone) + "]}");
    } catch (Exception) { }
  }

  static void Foreground(IntPtr hwnd) {
    IntPtr root = hwnd == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hwnd, GA_ROOT);
    if (root == IntPtr.Zero) root = hwnd;
    if (root != fgRoot) { fgRoot = root; WatchTitle(root); }
    string d = Describe(root);
    if (d == lastFg) return;
    lastFg = d;
    if (root != IntPtr.Zero && d.Contains("\"kind\":\"app\"") && !seen.Contains(root)) { seen.Add(root); if (seen.Count > 64) seen.RemoveAt(0); }
    Out("{\"fg\":" + d + "}");
  }

  // Title changes only from the process in front (a global name-change hook would hear every
  // tooltip and list item in every app).
  static void WatchTitle(IntPtr root) {
    uint pid = root == IntPtr.Zero ? 0 : Pid(root);
    if (pid == nameHookPid) return;
    if (nameHook != IntPtr.Zero) UnhookWinEvent(nameHook);
    nameHook = IntPtr.Zero;
    nameHookPid = pid;
    if (pid != 0) nameHook = SetWinEventHook(EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE, IntPtr.Zero, onEvent, pid, 0, WINEVENT_OUTOFCONTEXT);
  }

  static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  static bool Cloaked(IntPtr h) { int v; return DwmGetInt(h, 14, out v, 4) == 0 && v != 0; }
  static RECT Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }
  static string Text(IntPtr h) { StringBuilder s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  static string Cls(IntPtr h) { StringBuilder s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }

  static readonly Dictionary<uint, string[]> procCache = new Dictionary<uint, string[]>(); // pid -> [exe, elevated]
  static string[] ProcInfo(uint pid) {
    string[] hit;
    lock (procCache) { if (procCache.TryGetValue(pid, out hit)) return hit; }
    string exe = ""; bool elevated = false;
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h != IntPtr.Zero) {
      StringBuilder s = new StringBuilder(1024); int n = s.Capacity;
      if (QueryFullProcessImageName(h, 0, s, ref n)) exe = System.IO.Path.GetFileName(s.ToString());
      IntPtr tok;
      if (OpenProcessToken(h, 0x0008, out tok)) { // TOKEN_QUERY
        int e, ret;
        if (GetTokenInformation(tok, 20, out e, 4, out ret)) elevated = e != 0; // TokenElevation
        CloseHandle(tok);
      } else elevated = true; // its token is closed to us: an admin or another user's process
      CloseHandle(h);
    } else elevated = true;
    if (elevated && pid != 0) {
      // Our own token may be elevated too (then nothing is blocked).
      IntPtr self; int me = 0, r2;
      if (OpenProcessToken(Process.GetCurrentProcess().Handle, 0x0008, out self)) { GetTokenInformation(self, 20, out me, 4, out r2); CloseHandle(self); }
      if (me != 0) elevated = false;
    }
    hit = new string[] { exe, elevated ? "true" : "false" };
    lock (procCache) { if (procCache.Count > 512) procCache.Clear(); procCache[pid] = hit; }
    return hit;
  }

  static string Kind(IntPtr h, uint pid, string cls, string exe) {
    if (h == IntPtr.Zero) return "none";
    if (parent != 0 && pid == parent) return "orbit";
    if (ShellClasses.Contains(cls) || ShellExes.Contains(exe)) return "shell";
    if (cls == "Windows.UI.Core.CoreWindow" && exe.Equals("explorer.exe", StringComparison.OrdinalIgnoreCase)) return "shell";
    return "app";
  }

  public static string Describe(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return "{\"hwnd\":0,\"kind\":\"none\"}";
    uint pid = Pid(h);
    string[] pi = ProcInfo(pid);
    string cls = Cls(h);
    string kind = Kind(h, pid, cls, pi[0]);
    IntPtr owner = GetAncestor(h, GA_ROOTOWNER);
    RECT r = Bounds(h);
    uint dpi = GetDpiForWindow(h);
    StringBuilder sb = new StringBuilder("{");
    sb.Append("\"hwnd\":").Append(h.ToInt64())
      .Append(",\"owner\":").Append(owner != h && owner != IntPtr.Zero ? owner.ToInt64() : 0)
      .Append(",\"pid\":").Append(pid)
      .Append(",\"exe\":").Append(Str(pi[0]))
      .Append(",\"title\":").Append(Str(Text(h)))
      .Append(",\"cls\":").Append(Str(cls))
      .Append(",\"kind\":\"").Append(kind).Append('"')
      .Append(",\"min\":").Append(IsIconic(h) ? "true" : "false")
      .Append(",\"max\":").Append(IsZoomed(h) ? "true" : "false")
      .Append(",\"cloaked\":").Append(Cloaked(h) ? "true" : "false")
      .Append(",\"elevated\":").Append(pi[1])
      .Append(",\"x\":").Append(r.L).Append(",\"y\":").Append(r.T).Append(",\"w\":").Append(r.R - r.L).Append(",\"h\":").Append(r.B - r.T)
      .Append(",\"dpi\":").Append(dpi == 0 ? 96 : dpi)
      .Append('}');
    return sb.ToString();
  }

  // The windows Alt+Tab shows: visible, not cloaked (other virtual desktops, suspended apps), not a
  // tool window, unowned or app-window style, with a title. Front first (EnumWindows' z-order).
  static string List() {
    List<string> items = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || Cloaked(h) || GetWindowTextLength(h) == 0) return true;
      long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
      if ((ex & WS_EX_TOOLWINDOW) != 0 || (ex & WS_EX_NOACTIVATE) != 0) return true;
      if (GetWindow(h, GW_OWNER) != IntPtr.Zero && (ex & 0x40000) == 0) return true; // owned, not WS_EX_APPWINDOW
      string d = Describe(h);
      if (!d.Contains("\"kind\":\"app\"")) return true;
      items.Add(d);
      return items.Count < 60;
    }, IntPtr.Zero);
    return "[" + string.Join(",", items) + "]";
  }

  static void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] p = line.Trim().Split(' ');
      long id;
      if (p.Length < 2 || !long.TryParse(p[1], out id)) { if (p[0] == "quit") break; continue; }
      try {
        if (p[0] == "describe" && p.Length == 3) {
          long h;
          string d = long.TryParse(p[2], out h) && h > 0 && IsWindow(new IntPtr(h)) ? Describe(new IntPtr(h)) : "null";
          Out("{\"id\":" + id + ",\"describe\":" + d + "}");
        } else if (p[0] == "list") {
          Out("{\"id\":" + id + ",\"list\":" + List() + "}");
        }
      } catch (Exception e) { Out("{\"id\":" + id + ",\"error\":" + Str(e.GetType().Name) + "}"); }
    }
    PostThreadMessage(loopThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
    Environment.Exit(0); // Orbit closed our stdin: it quit or crashed
  }

  public static string Str(string s) {
    if (s == null) return "\"\"";
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < 0x20 || c == 0x2028 || c == 0x2029) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static void Out(string line) {
    lock (outGate) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  }
}
'@

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[OrbitFocus]::Run($ParentPid)
