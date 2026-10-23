# "Orbit anywhere" UI Automation helper: reads (and, from phase 5, acts on) one app window at a time
# through COM UI Automation (CUIAutomation8), with AutoSetFocus OFF, so nothing it does pulls a
# window to the front (Microsoft: "most UI Automation methods that perform an action on an element
# set focus to the element before performing the action" by default; tested in the brief: 11 of 12
# steals with it on, 0 of 8 with it off). Long-lived; one JSON request per line on stdin, one JSON
# answer per line on stdout, tagged with the request's id.
#
# The COM interfaces come from Windows' own type library (UIAutomationCore.dll), converted once
# into an interop assembly kept in -Cache (per UIAutomationCore version), so nothing is shipped.
#
# Requests: {"id":n,"op":"scan","hwnd":h,"maxNodes":2000,"values":false}
#   -> {"id":n,"ok":true,"fw":"Win32|WPF|Chrome|XAML|...","nodes":[<node>,...],"truncated":false,"ms":..}
#   <node> = {"i":index,"p":parent index (-1 for the root),"t":"Button","n":"name","a":"automationId",
#             "c":"className","r":[x,y,w,h],"en":1,"off":0,"foc":0,"kf":1,"pw":0,"pat":"VITSEXR","ro":0,
#             "v":"value (values:true only, never for password fields)","rid":"runtime id"}
#   pat letters: V value, I invoke, T toggle, S selection item, E expand/collapse, X text, R range,
#   L scroll, A legacy (MSAA).
# {"id":n,"op":"read","hwnd":h,"maxChars":6000}
#   -> {"ok":true,"title":"..","lines":["label: value", "text", ...],"truncated":false,"focused":{"t","n"}|null}
#   The window's visible text in reading order: names of text, list, tree and link elements, the
#   values of edit boxes and documents (never password fields), the control with keyboard focus.
# {"id":n,"op":"selection","hwnd":h}
#   -> {"ok":true,"kind":"text","text":"..","from":{"t","n"}} | {"kind":"items","items":[..]} | {"kind":"none"}
#   Selected text (text pattern, or a classic edit box asked read-only with EM_GETSEL/WM_GETTEXT),
#   else the selected list items. Nothing is copied: the clipboard is never touched.
# {"id":n,"op":"act","hwnd":h,"i":index,"rid":"runtime id","t":"Button","action":"set_text|type|press|toggle|select|expand|collapse","value":".."}
#   -> {"ok":true,"via":"uia-value|wm-char|wm-settext|bn-clicked|uia-invoke|uia-toggle|uia-select|..","verified":true,"stoleFocus":false}
#   One act on the node `i` of the last scan of that window (found again by its runtime id if the
#   tree changed). Errors: stale, disabled, password, not_supported.
# Errors: {"id":n,"ok":false,"error":"code","message":"..."} (codes: no_window, access_denied,
#   timeout, bad_request, failed).
param([int]$ParentPid = 0, [string]$Cache = '')
$ErrorActionPreference = 'Stop'

# ---- the interop assembly (converted from Windows' own type library, once per version) ----
$core = Join-Path $env:SystemRoot 'System32\UIAutomationCore.dll'
$ver = ((Get-Item $core).VersionInfo.FileVersion -replace '[^0-9A-Za-z.]', '_')
if (-not $Cache) { $Cache = Join-Path $env:LOCALAPPDATA 'Orbit\cache' }
$dir = Join-Path $Cache "uia-$ver"
$dll = Join-Path $dir 'Interop.UIAutomationClient.dll'
if (-not (Test-Path $dll)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = Join-Path $dir ("tmp-" + $PID)
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Reflection;
public class OrbitTlb : ITypeLibImporterNotifySink {
  [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)] static extern void LoadTypeLibEx(string f, int kind, [MarshalAs(UnmanagedType.Interface)] out object tl);
  public void ReportEvent(ImporterEventKind k, int c, string m) { }
  public Assembly ResolveRef(object tl) { return null; }
  public static void Make(string core, string dir) {
    object tl; LoadTypeLibEx(core, 2, out tl); // REGKIND_NONE
    var ab = new TypeLibConverter().ConvertTypeLibToAssembly(tl, System.IO.Path.Combine(dir, "Interop.UIAutomationClient.dll"), TypeLibImporterFlags.None, new OrbitTlb(), null, null, "UIAutomationClient", null);
    ab.Save("Interop.UIAutomationClient.dll");
  }
}
'@
  $here = [Environment]::CurrentDirectory
  [Environment]::CurrentDirectory = $tmp
  try { [OrbitTlb]::Make($core, $tmp) } finally { [Environment]::CurrentDirectory = $here }
  try { Move-Item -Path (Join-Path $tmp 'Interop.UIAutomationClient.dll') -Destination $dll -ErrorAction Stop } catch { if (-not (Test-Path $dll)) { throw } }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# Loaded by path, and handed out by name (it isn't in any folder .NET searches; a resolver in C#,
# because a PowerShell one can't run on the helper's own thread).
Add-Type -TypeDefinition @'
using System; using System.Reflection;
public static class OrbitResolve {
  static Assembly interop;
  public static void Register(string path) {
    interop = Assembly.LoadFrom(path);
    AppDomain.CurrentDomain.AssemblyResolve += (s, e) => e.Name.StartsWith("UIAutomationClient,") || e.Name.StartsWith("Interop.UIAutomationClient,") ? interop : null;
  }
}
'@
[OrbitResolve]::Register($dll)
Add-Type -ReferencedAssemblies $dll, 'System.Web.Extensions' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using UIAutomationClient;

public static class OrbitUia {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
  static readonly object outGate = new object();
  static IUIAutomation2 uia;
  static int parent;
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);

  // Property ids (UIAutomationClient.h)
  const int P_RuntimeId = 30000, P_Rect = 30001, P_ControlType = 30003, P_Name = 30005, P_HasFocus = 30008,
    P_KeyboardFocusable = 30009, P_Enabled = 30010, P_AutomationId = 30011, P_Class = 30012, P_IsPassword = 30019,
    P_Offscreen = 30022, P_Framework = 30024, P_HasExpand = 30028, P_HasInvoke = 30031, P_HasRange = 30033,
    P_HasScroll = 30034, P_HasSelItem = 30036, P_HasText = 30040, P_HasToggle = 30041, P_HasValue = 30043,
    P_Value = 30045, P_ValueReadOnly = 30046, P_HasLegacy = 30090, P_NativeWindowHandle = 30020;

  static readonly Dictionary<int, string> Types = new Dictionary<int, string> {
    {50000,"Button"},{50001,"Calendar"},{50002,"CheckBox"},{50003,"ComboBox"},{50004,"Edit"},{50005,"Hyperlink"},
    {50006,"Image"},{50007,"ListItem"},{50008,"List"},{50009,"Menu"},{50010,"MenuBar"},{50011,"MenuItem"},
    {50012,"ProgressBar"},{50013,"RadioButton"},{50014,"ScrollBar"},{50015,"Slider"},{50016,"Spinner"},
    {50017,"StatusBar"},{50018,"Tab"},{50019,"TabItem"},{50020,"Text"},{50021,"ToolBar"},{50022,"ToolTip"},
    {50023,"Tree"},{50024,"TreeItem"},{50025,"Custom"},{50026,"Group"},{50027,"Thumb"},{50028,"DataGrid"},
    {50029,"DataItem"},{50030,"Document"},{50031,"SplitButton"},{50032,"Window"},{50033,"Pane"},{50034,"Header"},
    {50035,"HeaderItem"},{50036,"Table"},{50037,"TitleBar"},{50038,"Separator"},{50039,"SemanticZoom"},{50040,"AppBar"} };

  public static void Run(int parentPid) {
    parent = parentPid;
    Thread t = new Thread(Loop);
    t.SetApartmentState(ApartmentState.MTA); // UI Automation clients belong on an MTA thread
    t.IsBackground = false;
    t.Start();
    t.Join();
  }

  static void Loop() {
    uia = (IUIAutomation2)new CUIAutomation8();
    uia.AutoSetFocus = 0;              // never pull a window forward
    uia.ConnectionTimeout = 4000;      // a hung app can't hang us for long
    uia.TransactionTimeout = 8000;
    Timer watchdog = new Timer(_ => {
      if (parent == 0) return;
      try { if (Process.GetProcessById(parent).HasExited) Environment.Exit(0); } catch (ArgumentException) { Environment.Exit(0); }
    }, null, 2000, 2000);
    var stdin = new System.IO.StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = stdin.ReadLine()) != null) {
      Dictionary<string, object> req = null;
      object id = null;
      try {
        req = Json.Deserialize<Dictionary<string, object>>(line);
        if (req == null) continue;
        req.TryGetValue("id", out id);
        Dictionary<string, object> res = Handle(req);
        res["id"] = id;
        Out(res);
      } catch (COMException e) {
        uint hr = (uint)e.ErrorCode;
        Out(Err(id, hr == 0x80131505 ? "timeout" : hr == 0x80070005 ? "access_denied" : hr == 0x80040201 ? "gone" : "failed", e.Message));
      } catch (TimeoutException e) {
        Out(Err(id, "timeout", e.Message));
      } catch (UnauthorizedAccessException e) {
        Out(Err(id, "access_denied", e.Message));
      } catch (Exception e) {
        Out(Err(id, req == null ? "bad_request" : "failed", e.GetType().Name + ": " + e.Message));
      }
    }
    Environment.Exit(0);
  }

  static Dictionary<string, object> Err(object id, string code, string message) {
    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", code }, { "message", Cut(message, 300) } };
  }

  static Dictionary<string, object> Handle(Dictionary<string, object> req) {
    string op = Str(req, "op");
    if (op == "ping") return Ok();
    if (op == "scan") return Scan(req);
    if (op == "read") return Read(req);
    if (op == "selection") return Selection(req);
    if (op == "act") return Act(req);
    throw new ArgumentException("unknown op");
  }

  static Dictionary<string, object> Ok() { return new Dictionary<string, object> { { "ok", true } }; }

  // ---------------- reading the tree ----------------
  static IUIAutomationElement Root(Dictionary<string, object> req) {
    long h = Long(req, "hwnd");
    if (h <= 0 || !IsWindow(new IntPtr(h))) throw new NoWindow();
    return uia.ElementFromHandle(new IntPtr(h));
  }
  class NoWindow : Exception { public NoWindow() : base("no such window") { } }

  static IUIAutomationCacheRequest Request(bool values) {
    IUIAutomationCacheRequest cr = uia.CreateCacheRequest();
    foreach (int p in new int[] { P_RuntimeId, P_Rect, P_ControlType, P_Name, P_HasFocus, P_KeyboardFocusable, P_Enabled,
      P_AutomationId, P_Class, P_IsPassword, P_Offscreen, P_Framework, P_HasExpand, P_HasInvoke, P_HasRange, P_HasScroll,
      P_HasSelItem, P_HasText, P_HasToggle, P_HasValue, P_ValueReadOnly, P_HasLegacy }) cr.AddProperty(p);
    if (values) cr.AddProperty(P_Value);
    cr.TreeScope = TreeScope.TreeScope_Subtree;
    cr.TreeFilter = uia.ControlViewCondition;
    cr.AutomationElementMode = AutomationElementMode.AutomationElementMode_Full;
    return cr;
  }

  static Dictionary<string, object> Scan(Dictionary<string, object> req) {
    Stopwatch sw = Stopwatch.StartNew();
    int max = (int)Math.Max(1, Math.Min(20000, Long(req, "maxNodes", 2000)));
    bool values = Bool(req, "values");
    IUIAutomationElement root;
    try { root = Root(req); } catch (NoWindow) { return Fail("no_window", "That window is gone."); }
    IUIAutomationCacheRequest cr = Request(values);
    IUIAutomationElement cached = root.BuildUpdatedCache(cr);
    List<object> nodes = new List<object>();
    List<IUIAutomationElement> els = new List<IUIAutomationElement>();
    bool truncated = Walk(cached, -1, nodes, max, values, els);
    string fw = S(cached.GetCachedPropertyValue(P_Framework));
    // Chromium and Electron build their tree on the first question (Discord: 8 -> 445 elements):
    // ask again once it has had a moment.
    if (nodes.Count < 40 && (fw == "Chrome" || S(cached.GetCachedPropertyValue(P_Class)).StartsWith("Chrome_WidgetWin"))) {
      Thread.Sleep(700);
      cached = root.BuildUpdatedCache(cr);
      nodes.Clear();
      els.Clear();
      truncated = Walk(cached, -1, nodes, max, values, els);
    }
    lastScan[Long(req, "hwnd")] = els; // acts name a node of this scan (see Act)
    if (lastScan.Count > 24) { foreach (long k in new List<long>(lastScan.Keys)) if (!IsWindow(new IntPtr(k))) lastScan.Remove(k); }
    if (fw == "") foreach (object o in nodes) { var d = (Dictionary<string, object>)o; if (d.ContainsKey("fw")) { fw = (string)d["fw"]; break; } }
    var res = Ok();
    res["fw"] = fw;
    res["nodes"] = nodes;
    res["truncated"] = truncated;
    res["ms"] = sw.ElapsedMilliseconds;
    return res;
  }

  static Dictionary<string, object> Fail(string code, string message) {
    return new Dictionary<string, object> { { "ok", false }, { "error", code }, { "message", message } };
  }

  // Depth-first, so a parent always comes before its children. True if it stopped at max.
  static bool Walk(IUIAutomationElement e, int parentIndex, List<object> nodes, int max, bool values, List<IUIAutomationElement> els = null) {
    if (nodes.Count >= max) return true;
    int me = nodes.Count;
    nodes.Add(Node(e, me, parentIndex, values));
    if (els != null) els.Add(e);
    IUIAutomationElementArray kids = null;
    try { kids = e.GetCachedChildren(); } catch (Exception) { }
    if (kids == null) return false;
    for (int i = 0; i < kids.Length; i++) if (Walk(kids.GetElement(i), me, nodes, max, values, els)) return true;
    return false;
  }

  static Dictionary<string, object> Node(IUIAutomationElement e, int index, int parentIndex, bool values) {
    var d = new Dictionary<string, object>();
    d["i"] = index;
    d["p"] = parentIndex;
    int ct = I(e.GetCachedPropertyValue(P_ControlType));
    string type;
    d["t"] = Types.TryGetValue(ct, out type) ? type : "Custom";
    string name = S(e.GetCachedPropertyValue(P_Name));
    if (name != "") d["n"] = Cut(name, 200);
    string aid = S(e.GetCachedPropertyValue(P_AutomationId));
    if (aid != "") d["a"] = Cut(aid, 120);
    string cls = S(e.GetCachedPropertyValue(P_Class));
    if (cls != "") d["c"] = Cut(cls, 120);
    if (index == 0) { string fw = S(e.GetCachedPropertyValue(P_Framework)); if (fw != "") d["fw"] = fw; }
    object rv = e.GetCachedPropertyValue(P_Rect);
    double[] r = rv as double[];
    if (r != null && r.Length == 4) d["r"] = new long[] { (long)Math.Round(r[0]), (long)Math.Round(r[1]), (long)Math.Round(r[2]), (long)Math.Round(r[3]) };
    d["en"] = B(e.GetCachedPropertyValue(P_Enabled)) ? 1 : 0;
    if (B(e.GetCachedPropertyValue(P_Offscreen))) d["off"] = 1;
    if (B(e.GetCachedPropertyValue(P_HasFocus))) d["foc"] = 1;
    if (B(e.GetCachedPropertyValue(P_KeyboardFocusable))) d["kf"] = 1;
    bool pw = B(e.GetCachedPropertyValue(P_IsPassword));
    if (pw) d["pw"] = 1;
    StringBuilder pat = new StringBuilder();
    if (B(e.GetCachedPropertyValue(P_HasValue))) pat.Append('V');
    if (B(e.GetCachedPropertyValue(P_HasInvoke))) pat.Append('I');
    if (B(e.GetCachedPropertyValue(P_HasToggle))) pat.Append('T');
    if (B(e.GetCachedPropertyValue(P_HasSelItem))) pat.Append('S');
    if (B(e.GetCachedPropertyValue(P_HasExpand))) pat.Append('E');
    if (B(e.GetCachedPropertyValue(P_HasText))) pat.Append('X');
    if (B(e.GetCachedPropertyValue(P_HasRange))) pat.Append('R');
    if (B(e.GetCachedPropertyValue(P_HasScroll))) pat.Append('L');
    if (B(e.GetCachedPropertyValue(P_HasLegacy))) pat.Append('A');
    if (pat.Length > 0) d["pat"] = pat.ToString();
    if (pat.ToString().Contains("V") && B(e.GetCachedPropertyValue(P_ValueReadOnly))) d["ro"] = 1;
    if (values && !pw && pat.ToString().Contains("V")) { string v = S(e.GetCachedPropertyValue(P_Value)); if (v != "") d["v"] = Cut(v, 4000); }
    int[] rid = e.GetCachedPropertyValue(P_RuntimeId) as int[];
    if (rid != null) d["rid"] = string.Join(".", Array.ConvertAll(rid, x => x.ToString()));
    return d;
  }

  // ---------------- reading what's in a window (phase 3) ----------------
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")] static extern IntPtr SendMessageTimeoutText(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint ms, out IntPtr result);
  const int TextPatternId = 10014, SelectionPatternId = 10001;
  const uint WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E, EM_GETSEL = 0x00B0, SMTO_ABORTIFHUNG = 0x2;

  static uint WinPid(long hwnd) { uint p; GetWindowThreadProcessId(new IntPtr(hwnd), out p); return p; }

  // Content-bearing kinds of element, read in tree order.
  static readonly HashSet<string> ContentTypes = new HashSet<string> { "Text", "ListItem", "TreeItem", "DataItem", "Hyperlink", "HeaderItem", "Document", "Edit", "TabItem", "Header", "MenuItem", "StatusBar", "TitleBar" };

  /** The window's text as lines (labels, values, documents), the focused control, and the title. */
  static Dictionary<string, object> Read(Dictionary<string, object> req) {
    Stopwatch sw = Stopwatch.StartNew();
    int maxChars = (int)Math.Max(200, Math.Min(40000, Long(req, "maxChars", 6000)));
    IUIAutomationElement root;
    try { root = Root(req); } catch (NoWindow) { return Fail("no_window", "That window is gone."); }
    IUIAutomationElement cached = root.BuildUpdatedCache(Request(true));
    bool rootOff = B(cached.GetCachedPropertyValue(P_Offscreen));
    List<string> lines = new List<string>();
    int chars = 0; bool truncated = false; int docs = 0;
    // (element, the kind of its parent, inside the title bar or a button)
    Stack<Tuple<IUIAutomationElement, string, bool>> todo = new Stack<Tuple<IUIAutomationElement, string, bool>>();
    todo.Push(Tuple.Create(cached, "", false));
    string last = null;
    while (todo.Count > 0) {
      var item = todo.Pop();
      IUIAutomationElement e = item.Item1;
      string type; Types.TryGetValue(I(e.GetCachedPropertyValue(P_ControlType)), out type);
      // A button's own caption and the title bar's buttons are controls, not content.
      bool skipUnder = item.Item3 || type == "TitleBar" || type == "Button" || type == "CheckBox" || type == "RadioButton" || type == "SplitButton";
      IUIAutomationElementArray kids = null;
      try { kids = e.GetCachedChildren(); } catch (Exception) { }
      if (kids != null) for (int i = kids.Length - 1; i >= 0; i--) todo.Push(Tuple.Create(kids.GetElement(i), type ?? "", skipUnder));
      if (e == cached || item.Item3) continue;
      if (B(e.GetCachedPropertyValue(P_IsPassword))) continue;
      if (!rootOff && B(e.GetCachedPropertyValue(P_Offscreen))) continue; // scrolled away, collapsed
      if (type == null || !ContentTypes.Contains(type)) continue;
      string name = S(e.GetCachedPropertyValue(P_Name)).Trim();
      string value = B(e.GetCachedPropertyValue(P_HasValue)) ? S(e.GetCachedPropertyValue(P_Value)) : "";
      string line;
      if (type == "Edit" || type == "Document") {
        string text = value;
        if (text == "" && B(e.GetCachedPropertyValue(P_HasText)) && docs < 4) {
          docs++;
          try {
            IUIAutomationTextPattern tp = (IUIAutomationTextPattern)e.GetCurrentPattern(TextPatternId);
            text = tp.DocumentRange.GetText(maxChars - chars + 1);
          } catch (Exception) { }
        }
        if (text == "" && name == "") continue;
        line = (name != "" ? name + ": " : "") + text;
      } else if (type == "TitleBar") {
        continue; // the title is reported on its own
      } else {
        if (name == "") continue;
        line = name;
      }
      line = line.Replace("\r\n", "\n").Trim();
      if (line == "" || line == last) continue;
      last = line;
      if (chars + line.Length > maxChars) { lines.Add(line.Substring(0, Math.Max(0, maxChars - chars))); truncated = true; break; }
      lines.Add(line);
      chars += line.Length + 1;
    }
    var res = Ok();
    res["title"] = Cut(S(cached.GetCachedPropertyValue(P_Name)), 300);
    res["lines"] = lines;
    res["truncated"] = truncated;
    res["focused"] = Focused(Long(req, "hwnd"));
    res["ms"] = sw.ElapsedMilliseconds;
    return res;
  }

  /** The control with keyboard focus, if it's in this window's app: { t, n } (never its value). */
  static object Focused(long hwnd) {
    try {
      IUIAutomationElement f = uia.GetFocusedElement();
      if (f == null || (uint)f.CurrentProcessId != WinPid(hwnd)) return null;
      string type; Types.TryGetValue(f.CurrentControlType, out type);
      var d = new Dictionary<string, object> { { "t", type ?? "Custom" } };
      string n = f.CurrentName ?? "";
      if (n != "") d["n"] = Cut(n, 200);
      if (f.CurrentIsPassword != 0) d["pw"] = 1;
      return d;
    } catch (Exception) { return null; }
  }

  /** What's selected in the window: selected text (text controls, or classic edit boxes), or the selected items of a list. */
  static Dictionary<string, object> Selection(Dictionary<string, object> req) {
    int maxChars = (int)Math.Max(100, Math.Min(40000, Long(req, "maxChars", 8000)));
    long hwnd = Long(req, "hwnd");
    IUIAutomationElement root;
    try { root = Root(req); } catch (NoWindow) { return Fail("no_window", "That window is gone."); }
    List<IUIAutomationElement> candidates = new List<IUIAutomationElement>();
    try {
      IUIAutomationElement f = uia.GetFocusedElement();
      if (f != null && (uint)f.CurrentProcessId == WinPid(hwnd)) candidates.Add(f);
    } catch (Exception) { }
    try {
      IUIAutomationElementArray texts = root.FindAll(TreeScope.TreeScope_Descendants, uia.CreatePropertyCondition(P_HasText, true));
      for (int i = 0; i < texts.Length && i < 40; i++) candidates.Add(texts.GetElement(i));
    } catch (Exception) { }
    foreach (IUIAutomationElement e in candidates) {
      try {
        if (e.CurrentIsPassword != 0) continue;
        object pat = e.GetCurrentPattern(TextPatternId);
        if (pat == null) continue;
        IUIAutomationTextRangeArray sel = ((IUIAutomationTextPattern)pat).GetSelection();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; sel != null && i < sel.Length && sb.Length < maxChars; i++) sb.Append(sel.GetElement(i).GetText(maxChars - sb.Length));
        if (sb.ToString().Trim() != "") return Picked(sb.ToString(), e, "text");
      } catch (Exception) { }
    }
    // Classic edit boxes (no text pattern): ask the control itself, read-only (EM_GETSEL, WM_GETTEXT).
    try {
      IUIAutomationElementArray edits = root.FindAll(TreeScope.TreeScope_Descendants, uia.CreatePropertyCondition(P_ControlType, 50004));
      List<IUIAutomationElement> order = new List<IUIAutomationElement>();
      foreach (IUIAutomationElement c in candidates) if (c.CurrentControlType == 50004) order.Add(c);
      for (int i = 0; i < edits.Length && i < 40; i++) order.Add(edits.GetElement(i));
      foreach (IUIAutomationElement e in order) {
        if (e.CurrentIsPassword != 0) continue;
        IntPtr h = e.CurrentNativeWindowHandle;
        string cls = e.CurrentClassName ?? "";
        if (h == IntPtr.Zero || cls.IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) < 0) continue;
        IntPtr r;
        if (SendMessageTimeout(h, EM_GETSEL, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out r) == IntPtr.Zero) continue;
        int start = (int)((long)r & 0xFFFF), end = (int)(((long)r >> 16) & 0xFFFF);
        if (end <= start) continue;
        IntPtr len;
        SendMessageTimeout(h, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out len);
        StringBuilder text = new StringBuilder((int)len + 2);
        SendMessageTimeoutText(h, WM_GETTEXT, new IntPtr(text.Capacity), text, SMTO_ABORTIFHUNG, 1000, out r);
        string all = text.ToString();
        if (start < all.Length) return Picked(all.Substring(start, Math.Min(end, all.Length) - start), e, "text");
      }
    } catch (Exception) { }
    // Selected list or tree items (a channel, a file).
    try {
      IUIAutomationElementArray items = root.FindAll(TreeScope.TreeScope_Descendants, uia.CreatePropertyCondition(30079, true)); // SelectionItemIsSelected
      List<string> names = new List<string>();
      for (int i = 0; i < items.Length && names.Count < 20; i++) { string n = items.GetElement(i).CurrentName ?? ""; if (n.Trim() != "") names.Add(Cut(n.Trim(), 200)); }
      if (names.Count > 0) {
        var res = Ok();
        res["kind"] = "items";
        res["items"] = names;
        return res;
      }
    } catch (Exception) { }
    var none = Ok();
    none["kind"] = "none";
    return none;
  }

  static Dictionary<string, object> Picked(string text, IUIAutomationElement e, string kind) {
    var res = Ok();
    res["kind"] = kind;
    res["text"] = Cut(text.Replace("\r\n", "\n"), 40000);
    string type; Types.TryGetValue(e.CurrentControlType, out type);
    res["from"] = new Dictionary<string, object> { { "t", type ?? "Custom" }, { "n", Cut(e.CurrentName ?? "", 120) } };
    return res;
  }

  // ---------------- acting without focus (phase 5) ----------------
  // One act on one control: UI Automation with AutoSetFocus off, or window messages for classic
  // Win32 controls (WM_CHAR typing into an EDIT, BN_CLICKED to a BUTTON's parent: their UIA proxy
  // simulates a real click, which pulls the window forward). Checked first (still there, enabled,
  // not a password field) and read back after. Reports whether the foreground changed anyway.
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  const uint WM_CHAR = 0x0102, WM_COMMAND = 0x0111, WM_SETTEXT = 0x000C;
  const int InvokePatternId = 10000, ValuePatternId = 10002, ExpandCollapsePatternId = 10005, SelectionItemPatternId = 10010, TogglePatternId = 10015, LegacyPatternId = 10018;

  // The elements of the last scan of each window, by index (acts name a node of a scan just taken).
  static readonly Dictionary<long, List<IUIAutomationElement>> lastScan = new Dictionary<long, List<IUIAutomationElement>>();

  static string Rid(IUIAutomationElement e) {
    try { int[] r = e.GetRuntimeId() as int[]; return r == null ? "" : string.Join(".", Array.ConvertAll(r, x => x.ToString())); } catch (Exception) { return ""; }
  }

  static IUIAutomationElement Target(long hwnd, int i, string rid) {
    List<IUIAutomationElement> els;
    if (lastScan.TryGetValue(hwnd, out els) && i >= 0 && i < els.Count) {
      IUIAutomationElement e = els[i];
      if (rid == "" || Rid(e) == rid) return e;
    }
    if (rid == "") return null;
    // Not where it was: look for it by its runtime id in a fresh look at the window.
    IUIAutomationElement root = uia.ElementFromHandle(new IntPtr(hwnd));
    IUIAutomationElement cached = root.BuildUpdatedCache(Request(false));
    List<object> nodes = new List<object>();
    List<IUIAutomationElement> fresh = new List<IUIAutomationElement>();
    Walk(cached, -1, nodes, 20000, false, fresh);
    lastScan[hwnd] = fresh;
    foreach (IUIAutomationElement e in fresh) if (Rid(e) == rid) return e;
    return null;
  }

  static string Norm(string s) { return (s ?? "").Replace("\r\n", "\n").Replace("\r", "\n"); }

  static Dictionary<string, object> Act(Dictionary<string, object> req) {
    long hwnd = Long(req, "hwnd");
    if (hwnd <= 0 || !IsWindow(new IntPtr(hwnd))) return Fail("no_window", "That window is gone.");
    string action = Str(req, "action"), value = Str(req, "value");
    IUIAutomationElement el = Target(hwnd, (int)Long(req, "i", -1), Str(req, "rid"));
    if (el == null) return Fail("stale", "That control isn't there any more.");
    string type; Types.TryGetValue(el.CurrentControlType, out type);
    if (Str(req, "t") != "" && type != Str(req, "t")) return Fail("stale", "That control changed.");
    if (el.CurrentIsPassword != 0) return Fail("password", "Never a password field.");
    if (el.CurrentIsEnabled == 0) return Fail("disabled", "That control is turned off.");
    IntPtr native = el.CurrentNativeWindowHandle;
    string cls = el.CurrentClassName ?? "";
    bool classicEdit = native != IntPtr.Zero && cls.IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0;
    bool classicButton = native != IntPtr.Zero && cls.IndexOf("BUTTON", StringComparison.OrdinalIgnoreCase) >= 0;
    IntPtr fgBefore = GetForegroundWindow();
    string via = ""; bool verified = true;

    if (action == "set_text" || action == "type") {
      IUIAutomationValuePattern vp = el.GetCurrentPattern(ValuePatternId) as IUIAutomationValuePattern;
      if (vp == null || vp.CurrentIsReadOnly != 0) return Fail("not_supported", "That control doesn't take text.");
      string before = vp.CurrentValue ?? "";
      string want = action == "type" ? before + value : value;
      if (action == "type" && classicEdit) {
        // Typed where the caret is, like keys (a classic edit box takes WM_CHAR even unfocused).
        foreach (char ch in value) PostMessage(native, WM_CHAR, new IntPtr(ch == '\n' ? '\r' : ch), new IntPtr(1));
        via = "wm-char";
        Stopwatch w = Stopwatch.StartNew();
        while (w.ElapsedMilliseconds < 1500 && Norm(vp.CurrentValue).Length < Norm(before).Length + Norm(value).Length) Thread.Sleep(30);
        verified = Norm(vp.CurrentValue).Contains(Norm(value));
      } else {
        vp.SetValue(want);
        via = "uia-value";
        verified = Norm(vp.CurrentValue) == Norm(want);
        if (!verified && classicEdit) {
          IntPtr r;
          SendMessageTimeoutText(native, WM_SETTEXT, IntPtr.Zero, new StringBuilder(want), SMTO_ABORTIFHUNG, 1000, out r);
          via = "wm-settext";
          verified = Norm(vp.CurrentValue) == Norm(want);
        }
      }
    } else if (action == "press" || (action == "toggle" && el.GetCurrentPattern(TogglePatternId) == null)) {
      if (classicButton) {
        // A classic button tells its parent it was clicked (BN_CLICKED): no simulated click.
        IntPtr parentWin = GetParent(native);
        int id = GetDlgCtrlID(native);
        PostMessage(parentWin, WM_COMMAND, new IntPtr(id & 0xFFFF), native);
        via = "bn-clicked";
      } else {
        IUIAutomationInvokePattern ip = el.GetCurrentPattern(InvokePatternId) as IUIAutomationInvokePattern;
        if (ip != null) { ip.Invoke(); via = "uia-invoke"; }
        else {
          IUIAutomationTogglePattern tp = el.GetCurrentPattern(TogglePatternId) as IUIAutomationTogglePattern;
          if (tp != null) { tp.Toggle(); via = "uia-toggle"; }
          else {
            IUIAutomationLegacyIAccessiblePattern lp = el.GetCurrentPattern(LegacyPatternId) as IUIAutomationLegacyIAccessiblePattern;
            if (lp == null) return Fail("not_supported", "That control can't be pressed.");
            lp.DoDefaultAction(); via = "msaa-default";
          }
        }
      }
    } else if (action == "toggle") {
      IUIAutomationTogglePattern tp = (IUIAutomationTogglePattern)el.GetCurrentPattern(TogglePatternId);
      ToggleState before = tp.CurrentToggleState;
      tp.Toggle();
      via = "uia-toggle";
      verified = tp.CurrentToggleState != before;
    } else if (action == "select") {
      IUIAutomationSelectionItemPattern sp = el.GetCurrentPattern(SelectionItemPatternId) as IUIAutomationSelectionItemPattern;
      if (sp == null) return Fail("not_supported", "That can't be picked.");
      sp.Select();
      via = "uia-select";
      verified = sp.CurrentIsSelected != 0;
    } else if (action == "expand" || action == "collapse") {
      IUIAutomationExpandCollapsePattern ep = el.GetCurrentPattern(ExpandCollapsePatternId) as IUIAutomationExpandCollapsePattern;
      if (ep == null) return Fail("not_supported", "That can't be opened or closed.");
      if (action == "expand") ep.Expand(); else ep.Collapse();
      via = "uia-" + action;
    } else {
      return Fail("bad_request", "unknown action");
    }
    Thread.Sleep(60);
    IntPtr fgAfter = GetForegroundWindow();
    var res = Ok();
    res["via"] = via;
    res["verified"] = verified;
    res["stoleFocus"] = fgAfter != fgBefore && fgAfter != IntPtr.Zero && GetAncestor(fgAfter, 2) == new IntPtr(hwnd);
    return res;
  }

  // ---------------- small helpers ----------------
  static string S(object o) { return o as string ?? ""; }
  static bool B(object o) { return o is bool ? (bool)o : (o is int ? (int)o != 0 : false); }
  static int I(object o) { return o is int ? (int)o : 0; }
  static string Cut(string s, int max) { return s == null ? "" : (s.Length <= max ? s : s.Substring(0, max)); }
  static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : ""; }
  static long Long(Dictionary<string, object> d, string k, long def = 0) { object v; if (!d.TryGetValue(k, out v) || v == null) return def; try { return Convert.ToInt64(v); } catch { return def; } }
  static bool Bool(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v is bool && (bool)v; }

  static void Out(Dictionary<string, object> res) {
    string s = Json.Serialize(res);
    lock (outGate) { stdout.WriteLine(s); stdout.Flush(); }
  }
  static readonly System.IO.TextWriter stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
}
'@

[OrbitUia]::Run($ParentPid)
