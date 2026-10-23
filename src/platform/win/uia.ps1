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
    bool truncated = Walk(cached, -1, nodes, max, values);
    string fw = S(cached.GetCachedPropertyValue(P_Framework));
    // Chromium and Electron build their tree on the first question (Discord: 8 -> 445 elements):
    // ask again once it has had a moment.
    if (nodes.Count < 40 && (fw == "Chrome" || S(cached.GetCachedPropertyValue(P_Class)).StartsWith("Chrome_WidgetWin"))) {
      Thread.Sleep(700);
      cached = root.BuildUpdatedCache(cr);
      nodes.Clear();
      truncated = Walk(cached, -1, nodes, max, values);
    }
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
  static bool Walk(IUIAutomationElement e, int parentIndex, List<object> nodes, int max, bool values) {
    if (nodes.Count >= max) return true;
    int me = nodes.Count;
    nodes.Add(Node(e, me, parentIndex, values));
    IUIAutomationElementArray kids = null;
    try { kids = e.GetCachedChildren(); } catch (Exception) { }
    if (kids == null) return false;
    for (int i = 0; i < kids.Length; i++) if (Walk(kids.GetElement(i), me, nodes, max, values)) return true;
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
