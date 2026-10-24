// The part of .NET's System.Windows.Automation that src/desktop.ps1 uses, with the same names,
// built on COM UI Automation (CUIAutomation8) with AutoSetFocus OFF.
//
// Why not the managed library itself: it has AutoSetFocus on, so every act (Invoke, SetValue,
// Toggle, Expand...) first focuses the control, which brings Claude's window to the front (the
// "Orbit anywhere" brief: 11 of 12 acts stole focus with it on, 0 of 8 with it off). And the two
// can't share a process: once the managed library has talked to a window, COM acts on it focus it
// too (tested on the stand-in window), so desktop.ps1 never loads the managed library at all.
//
// Searches see the control view, as the managed library's do (its default cache request filters
// on it). Compiled by desktop.ps1 against the interop assembly from uia-interop.ps1, once per
// version of this file, into Orbit's cache.
using System;
using System.Collections.Generic;
using System.Reflection;
using UIAutomationClient;

namespace OrbitAuto {
  /// <summary>
  /// Top-level windows of some processes, found with Win32 (EnumWindows), topmost first. Asking UI
  /// Automation for the desktop's children instead asks every app's windows, so one hung window
  /// anywhere (another app's) hung every look at Claude's.
  /// </summary>
  public static class Native {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    public static long[] TopWindows(int[] pids) {
      var want = new HashSet<uint>();
      foreach (int p in pids) want.Add((uint)p);
      var found = new List<long>();
      EnumWindows((h, l) => {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (want.Contains(pid) && IsWindowVisible(h)) found.Add(h.ToInt64());
        return true;
      }, IntPtr.Zero);
      return found.ToArray();
    }
  }

  /// <summary>Loads the interop assembly; called before anything below touches its types.</summary>
  public static class Interop {
    static Assembly interop;
    public static void Register(string path) {
      interop = Assembly.LoadFrom(path);
      AppDomain.CurrentDomain.AssemblyResolve += (s, e) => e.Name.StartsWith("Interop.UIAutomationClient,") ? interop : null;
    }
  }

  static class U {
    static IUIAutomation2 uia;
    static IUIAutomationCacheRequest controlView;
    public static IUIAutomation2 A {
      get {
        if (uia == null) {
          uia = (IUIAutomation2)new CUIAutomation8();
          uia.AutoSetFocus = 0; // never pull a window forward
          uia.ConnectionTimeout = 4000; // another app that hangs can't hang Orbit for long
          uia.TransactionTimeout = 8000;
        }
        return uia;
      }
    }
    // Searches in the control view, with live (not cached) elements back.
    public static IUIAutomationCacheRequest ControlView {
      get {
        if (controlView == null) {
          controlView = A.CreateCacheRequest();
          controlView.TreeFilter = A.ControlViewCondition;
          controlView.AutomationElementMode = AutomationElementMode.AutomationElementMode_Full;
        }
        return controlView;
      }
    }
    public static bool B(int v) { return v != 0; }
  }

  public enum TreeScope { Element = 1, Children = 2, Descendants = 4, Subtree = 7 }
  public enum ToggleState { Off = 0, On = 1, Indeterminate = 2 }
  public enum WindowVisualState { Normal = 0, Maximized = 1, Minimized = 2 }
  public enum ExpandCollapseState { Collapsed = 0, Expanded = 1, PartiallyExpanded = 2, LeafNode = 3 }
  public enum ScrollAmount { LargeDecrement = 0, SmallDecrement = 1, NoAmount = 2, LargeIncrement = 3, SmallIncrement = 4 }

  public sealed class ControlType {
    public readonly int Id;
    public readonly string ProgrammaticName;
    ControlType(int id, string name) { Id = id; ProgrammaticName = "ControlType." + name; }
    static readonly Dictionary<int, ControlType> ById = new Dictionary<int, ControlType>();
    static ControlType Make(int id, string name) { var t = new ControlType(id, name); ById[id] = t; return t; }
    public static ControlType LookupById(int id) {
      ControlType t;
      if (!ById.TryGetValue(id, out t)) t = Make(id, "Unknown" + id);
      return t;
    }
    public override bool Equals(object o) { var t = o as ControlType; return t != null && t.Id == Id; }
    public override int GetHashCode() { return Id; }
    public override string ToString() { return ProgrammaticName; }
    public static readonly ControlType Button = Make(50000, "Button"), Calendar = Make(50001, "Calendar"), CheckBox = Make(50002, "CheckBox"),
      ComboBox = Make(50003, "ComboBox"), Edit = Make(50004, "Edit"), Hyperlink = Make(50005, "Hyperlink"), Image = Make(50006, "Image"),
      ListItem = Make(50007, "ListItem"), List = Make(50008, "List"), Menu = Make(50009, "Menu"), MenuBar = Make(50010, "MenuBar"),
      MenuItem = Make(50011, "MenuItem"), ProgressBar = Make(50012, "ProgressBar"), RadioButton = Make(50013, "RadioButton"),
      ScrollBar = Make(50014, "ScrollBar"), Slider = Make(50015, "Slider"), Spinner = Make(50016, "Spinner"), StatusBar = Make(50017, "StatusBar"),
      Tab = Make(50018, "Tab"), TabItem = Make(50019, "TabItem"), Text = Make(50020, "Text"), ToolBar = Make(50021, "ToolBar"),
      ToolTip = Make(50022, "ToolTip"), Tree = Make(50023, "Tree"), TreeItem = Make(50024, "TreeItem"), Custom = Make(50025, "Custom"),
      Group = Make(50026, "Group"), Thumb = Make(50027, "Thumb"), DataGrid = Make(50028, "DataGrid"), DataItem = Make(50029, "DataItem"),
      Document = Make(50030, "Document"), SplitButton = Make(50031, "SplitButton"), Window = Make(50032, "Window"), Pane = Make(50033, "Pane"),
      Header = Make(50034, "Header"), HeaderItem = Make(50035, "HeaderItem"), Table = Make(50036, "Table"), TitleBar = Make(50037, "TitleBar"),
      Separator = Make(50038, "Separator");
  }

  public sealed class AutomationProperty {
    public readonly int Id;
    internal AutomationProperty(int id) { Id = id; }
  }

  public sealed class AutomationPattern {
    public readonly int Id;
    internal AutomationPattern(int id) { Id = id; }
  }

  // ---- conditions (made into COM conditions when a search runs) ----
  public abstract class Condition {
    IUIAutomationCondition made;
    internal IUIAutomationCondition Com { get { return made ?? (made = Make()); } }
    internal abstract IUIAutomationCondition Make();
    public static readonly Condition TrueCondition = new TrueCond();
    sealed class TrueCond : Condition { internal override IUIAutomationCondition Make() { return U.A.CreateTrueCondition(); } }
  }

  public class PropertyCondition : Condition {
    readonly AutomationProperty property;
    readonly object value;
    public PropertyCondition(AutomationProperty property, object value) { this.property = property; this.value = value; }
    internal override IUIAutomationCondition Make() {
      object v = value;
      var ct = v as ControlType;
      if (ct != null) v = ct.Id;
      return U.A.CreatePropertyCondition(property.Id, v);
    }
  }

  public class AndCondition : Condition {
    readonly Condition[] conditions;
    public AndCondition(params Condition[] conditions) { this.conditions = conditions; }
    internal override IUIAutomationCondition Make() {
      var a = new IUIAutomationCondition[conditions.Length];
      for (int i = 0; i < a.Length; i++) a[i] = conditions[i].Com;
      return U.A.CreateAndConditionFromArray(a);
    }
  }

  public class OrCondition : Condition {
    readonly Condition[] conditions;
    public OrCondition(params Condition[] conditions) { this.conditions = conditions; }
    internal override IUIAutomationCondition Make() {
      var a = new IUIAutomationCondition[conditions.Length];
      for (int i = 0; i < a.Length; i++) a[i] = conditions[i].Com;
      return U.A.CreateOrConditionFromArray(a);
    }
  }

  public sealed class Rect {
    public readonly double X, Y, Width, Height;
    internal Rect(tagRECT r) { X = r.left; Y = r.top; Width = r.right - r.left; Height = r.bottom - r.top; }
    public double Left { get { return X; } }
    public double Top { get { return Y; } }
    public double Right { get { return X + Width; } }
    public double Bottom { get { return Y + Height; } }
    public bool IsEmpty { get { return X == 0 && Y == 0 && Width == 0 && Height == 0; } }
  }

  // ---- elements ----
  public sealed class AutomationElement {
    internal readonly IUIAutomationElement E;
    internal AutomationElement(IUIAutomationElement e) { E = e; }
    internal static AutomationElement Wrap(IUIAutomationElement e) { return e == null ? null : new AutomationElement(e); }

    public static readonly AutomationProperty ProcessIdProperty = new AutomationProperty(30002), ControlTypeProperty = new AutomationProperty(30003),
      NameProperty = new AutomationProperty(30005), HasKeyboardFocusProperty = new AutomationProperty(30008), IsEnabledProperty = new AutomationProperty(30010),
      AutomationIdProperty = new AutomationProperty(30011), ClassNameProperty = new AutomationProperty(30012), IsOffscreenProperty = new AutomationProperty(30022),
      IsInvokePatternAvailableProperty = new AutomationProperty(30031), IsScrollPatternAvailableProperty = new AutomationProperty(30034),
      IsTogglePatternAvailableProperty = new AutomationProperty(30041), IsValuePatternAvailableProperty = new AutomationProperty(30043);

    public static AutomationElement RootElement { get { return new AutomationElement(U.A.GetRootElement()); } }
    public static AutomationElement FromHandle(IntPtr h) { return Wrap(U.A.ElementFromHandle(h)); }

    public AutomationElementInformation Current { get { return new AutomationElementInformation(E); } }

    public AutomationElement[] FindAll(TreeScope scope, Condition condition) {
      IUIAutomationElementArray found = E.FindAllBuildCache((UIAutomationClient.TreeScope)(int)scope, condition.Com, U.ControlView);
      if (found == null) return new AutomationElement[0];
      var list = new AutomationElement[found.Length];
      for (int i = 0; i < list.Length; i++) list[i] = new AutomationElement(found.GetElement(i));
      return list;
    }

    public AutomationElement FindFirst(TreeScope scope, Condition condition) {
      return Wrap(E.FindFirstBuildCache((UIAutomationClient.TreeScope)(int)scope, condition.Com, U.ControlView));
    }

    public int[] GetRuntimeId() { return E.GetRuntimeId() as int[]; }

    public void SetFocus() { E.SetFocus(); }

    public object GetCurrentPattern(AutomationPattern pattern) {
      object p;
      if (!TryGetCurrentPattern(pattern, out p)) throw new InvalidOperationException("Unsupported pattern.");
      return p;
    }

    public bool TryGetCurrentPattern(AutomationPattern pattern, out object patternObject) {
      patternObject = null;
      object raw = E.GetCurrentPattern(pattern.Id);
      if (raw == null) return false;
      switch (pattern.Id) {
        case InvokePattern.Id: patternObject = new InvokePattern((IUIAutomationInvokePattern)raw); break;
        case ValuePattern.Id: patternObject = new ValuePattern((IUIAutomationValuePattern)raw); break;
        case ScrollPattern.Id: patternObject = new ScrollPattern((IUIAutomationScrollPattern)raw); break;
        case ExpandCollapsePattern.Id: patternObject = new ExpandCollapsePattern((IUIAutomationExpandCollapsePattern)raw); break;
        case WindowPattern.Id: patternObject = new WindowPattern((IUIAutomationWindowPattern)raw); break;
        case SelectionItemPattern.Id: patternObject = new SelectionItemPattern((IUIAutomationSelectionItemPattern)raw); break;
        case TogglePattern.Id: patternObject = new TogglePattern((IUIAutomationTogglePattern)raw); break;
        default: return false;
      }
      return true;
    }
  }

  // Read live on each access, as the managed library's Current is.
  public sealed class AutomationElementInformation {
    readonly IUIAutomationElement e;
    internal AutomationElementInformation(IUIAutomationElement e) { this.e = e; }
    public string Name { get { return e.CurrentName ?? ""; } }
    public ControlType ControlType { get { return ControlType.LookupById(e.CurrentControlType); } }
    public string ClassName { get { return e.CurrentClassName ?? ""; } }
    public string AutomationId { get { return e.CurrentAutomationId ?? ""; } }
    public bool IsEnabled { get { return U.B(e.CurrentIsEnabled); } }
    public bool HasKeyboardFocus { get { return U.B(e.CurrentHasKeyboardFocus); } }
    public bool IsOffscreen { get { return U.B(e.CurrentIsOffscreen); } }
    public bool IsPassword { get { return U.B(e.CurrentIsPassword); } }
    public int ProcessId { get { return e.CurrentProcessId; } }
    public int NativeWindowHandle { get { return e.CurrentNativeWindowHandle.ToInt32(); } }
    public Rect BoundingRectangle { get { return new Rect(e.CurrentBoundingRectangle); } }
  }

  public sealed class TreeWalker {
    readonly IUIAutomationTreeWalker w;
    TreeWalker(IUIAutomationTreeWalker w) { this.w = w; }
    public static TreeWalker ControlViewWalker { get { return new TreeWalker(U.A.ControlViewWalker); } }
    public AutomationElement GetParent(AutomationElement el) { return AutomationElement.Wrap(w.GetParentElement(el.E)); }
  }

  public static class Automation {
    public static bool Compare(AutomationElement a, AutomationElement b) { return a != null && b != null && U.A.CompareElements(a.E, b.E) != 0; }
  }

  // ---- patterns: the members desktop.ps1 uses ----
  public sealed class InvokePattern {
    public const int Id = 10000;
    public static readonly AutomationPattern Pattern = new AutomationPattern(Id);
    readonly IUIAutomationInvokePattern p;
    internal InvokePattern(IUIAutomationInvokePattern p) { this.p = p; }
    public void Invoke() { p.Invoke(); }
  }

  public sealed class ValuePattern {
    public const int Id = 10002;
    public static readonly AutomationPattern Pattern = new AutomationPattern(Id);
    readonly IUIAutomationValuePattern p;
    internal ValuePattern(IUIAutomationValuePattern p) { this.p = p; }
    public void SetValue(string value) { p.SetValue(value ?? ""); }
    public Info Current { get { return new Info(p); } }
    public sealed class Info {
      readonly IUIAutomationValuePattern p;
      internal Info(IUIAutomationValuePattern p) { this.p = p; }
      public string Value { get { return p.CurrentValue ?? ""; } }
      public bool IsReadOnly { get { return U.B(p.CurrentIsReadOnly); } }
    }
  }

  public sealed class ScrollPattern {
    public const int Id = 10004;
    public const double NoScroll = -1;
    public static readonly AutomationPattern Pattern = new AutomationPattern(Id);
    readonly IUIAutomationScrollPattern p;
    internal ScrollPattern(IUIAutomationScrollPattern p) { this.p = p; }
    public void Scroll(ScrollAmount horizontal, ScrollAmount vertical) { p.Scroll((UIAutomationClient.ScrollAmount)(int)horizontal, (UIAutomationClient.ScrollAmount)(int)vertical); }
    public void SetScrollPercent(double horizontal, double vertical) { p.SetScrollPercent(horizontal, vertical); }
    public Info Current { get { return new Info(p); } }
    public sealed class Info {
      readonly IUIAutomationScrollPattern p;
      internal Info(IUIAutomationScrollPattern p) { this.p = p; }
      public bool VerticallyScrollable { get { return U.B(p.CurrentVerticallyScrollable); } }
      public bool HorizontallyScrollable { get { return U.B(p.CurrentHorizontallyScrollable); } }
      public double VerticalScrollPercent { get { return p.CurrentVerticalScrollPercent; } }
      public double HorizontalScrollPercent { get { return p.CurrentHorizontalScrollPercent; } }
    }
  }

  public sealed class ExpandCollapsePattern {
    public const int Id = 10005;
    public static readonly AutomationPattern Pattern = new AutomationPattern(Id);
    readonly IUIAutomationExpandCollapsePattern p;
    internal ExpandCollapsePattern(IUIAutomationExpandCollapsePattern p) { this.p = p; }
    public void Expand() { p.Expand(); }
    public void Collapse() { p.Collapse(); }
    public Info Current { get { return new Info(p); } }
    public sealed class Info {
      readonly IUIAutomationExpandCollapsePattern p;
      internal Info(IUIAutomationExpandCollapsePattern p) { this.p = p; }
      public ExpandCollapseState ExpandCollapseState { get { return (ExpandCollapseState)(int)p.CurrentExpandCollapseState; } }
    }
  }

  public sealed class WindowPattern {
    public const int Id = 10009;
    public static readonly AutomationPattern Pattern = new AutomationPattern(Id);
    readonly IUIAutomationWindowPattern p;
    internal WindowPattern(IUIAutomationWindowPattern p) { this.p = p; }
    public Info Current { get { return new Info(p); } }
    public sealed class Info {
      readonly IUIAutomationWindowPattern p;
      internal Info(IUIAutomationWindowPattern p) { this.p = p; }
      public WindowVisualState WindowVisualState { get { return (WindowVisualState)(int)p.CurrentWindowVisualState; } }
    }
  }

  public sealed class SelectionItemPattern {
    public const int Id = 10010;
    public static readonly AutomationPattern Pattern = new AutomationPattern(Id);
    readonly IUIAutomationSelectionItemPattern p;
    internal SelectionItemPattern(IUIAutomationSelectionItemPattern p) { this.p = p; }
    public void Select() { p.Select(); }
    public Info Current { get { return new Info(p); } }
    public sealed class Info {
      readonly IUIAutomationSelectionItemPattern p;
      internal Info(IUIAutomationSelectionItemPattern p) { this.p = p; }
      public bool IsSelected { get { return U.B(p.CurrentIsSelected); } }
    }
  }

  public sealed class TogglePattern {
    public const int Id = 10015;
    public static readonly AutomationPattern Pattern = new AutomationPattern(Id);
    readonly IUIAutomationTogglePattern p;
    internal TogglePattern(IUIAutomationTogglePattern p) { this.p = p; }
    public void Toggle() { p.Toggle(); }
    public Info Current { get { return new Info(p); } }
    public sealed class Info {
      readonly IUIAutomationTogglePattern p;
      internal Info(IUIAutomationTogglePattern p) { this.p = p; }
      public ToggleState ToggleState { get { return (ToggleState)(int)p.CurrentToggleState; } }
    }
  }
}
