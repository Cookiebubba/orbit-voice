// Test windows for "Orbit anywhere": ordinary app windows of our own, so focus tracking, reading
// and mouse-free actions are tested only against windows the tests start themselves (never the
// owner's apps). Built with .NET Framework's csc (see test/e2e/fake-app.mjs).
//
//   FakeApp.exe --winforms "<title>"   a classic Win32 window (WinForms: real EDIT, BUTTON and
//                                     checkbox controls, so window messages and the MSAA proxy apply)
//   FakeApp.exe --wpf "<title>"        a WPF window (UI Automation patterns only)
//
// Each has a text box "Message", a multi-line "Notes" box, a button "Send", a button "Save", a
// checkbox "Agree", a list "Channels" (general, random, help), a password box "Secret" (holding
// "hunter2-secret", which must never be read) and a label "Status". It comes up
// without taking focus, off screen (x -5200) unless --onscreen, and reports on stdout, one JSON
// object per line:
//   {"ready":true,"pid":..,"hwnd":..}
//   {"event":"click","name":"Send"} | {"event":"text","name":"Message","value":".."}
//   {"event":"check","name":"Agree","value":true} | {"event":"select","name":"Channels","value":"help"}
//   {"event":"activated"} | {"event":"deactivated"}       (it became / stopped being the active window)
// Commands on stdin, one JSON object per line, each acknowledged with {"ok":<n>} (n counts from 1):
//   {"activate":true}  bring it to the front (SetForegroundWindow, else minimize and restore)
//   {"minimize":true}  {"restore":true}  {"title":".."}  {"set":{"Message":".."}}  {"select":"Notes"}
//   {"selectText":{"name":"Notes","start":0,"length":5}}
//   {"topmost":true|false}  above (or back among) other windows, without activating it
//   {"rect":"Save"}  -> {"rect":{"name":"Save","x":..,"y":..,"w":..,"h":..}} (screen pixels: the app's own idea of where it is)
//   {"state":true}     -> {"state":{"Message":"..","Notes":"..","Agree":false,"Channel":"..","active":false,"min":false}}
//   {"quit":true}
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

static class FakeApp {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
  static readonly object outLock = new object();
  static int acks;
  // UTF-8 both ways, whatever the console code page (a GUI exe has no console to ask).
  static readonly System.IO.TextWriter Out = new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false));
  static readonly System.IO.TextReader In = new System.IO.StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false));
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

  public static void Emit(Dictionary<string, object> e) {
    lock (outLock) { Out.WriteLine(Json.Serialize(e)); Out.Flush(); }
  }
  static Dictionary<string, object> D(params object[] kv) {
    var d = new Dictionary<string, object>();
    for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
    return d;
  }

  interface IApp {
    IntPtr Hwnd { get; }
    void Invoke(Action a);
    void SetTitle(string t);
    void Set(string name, string value);
    void SelectText(string name, int start, int length);
    void Focus(string name);
    Dictionary<string, object> State();
    Dictionary<string, object> RectOf(string name);
    void Quit();
  }

  static IApp app;

  [STAThread]
  static int Main(string[] args) {
    string mode = args.Length > 0 ? args[0] : "--winforms";
    string title = args.Length > 1 && args[1].Trim() != "" ? args[1].Trim() : "ORBIT-TEST";
    bool onscreen = Array.IndexOf(args, "--onscreen") >= 0;
    var ready = new ManualResetEvent(false);
    var ui = new Thread(() => {
      // (Each constructor sets `app` itself, then runs its message loop until it quits.)
      if (mode == "--wpf") new WpfApp(title, onscreen, ready); else new FormsApp(title, onscreen, ready);
    });
    ui.SetApartmentState(ApartmentState.STA);
    ui.Start();
    ready.WaitOne();
    Emit(D("ready", true, "pid", Process.GetCurrentProcess().Id, "hwnd", app.Hwnd.ToInt64()));
    string line;
    while ((line = In.ReadLine()) != null) {
      Dictionary<string, object> c;
      try { c = Json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
      if (c == null) continue;
      int n = ++acks;
      if (c.ContainsKey("quit")) { app.Quit(); Emit(D("ok", n)); return 0; }
      try {
        if (c.ContainsKey("activate")) app.Invoke(() => {
          // The switch chain Orbit uses (tested 4 of 4): ask; if Windows refuses, minimize without
          // activating, then restore (which activates).
          SetForegroundWindow(app.Hwnd);
          if (GetForegroundWindow() != app.Hwnd) { ShowWindow(app.Hwnd, 7); ShowWindow(app.Hwnd, 9); }
        });
        if (c.ContainsKey("minimize")) app.Invoke(() => ShowWindow(app.Hwnd, GetForegroundWindow() == app.Hwnd ? 6 : 7)); // SW_MINIMIZE (the next window gets the foreground) or SW_SHOWMINNOACTIVE
        if (c.ContainsKey("restore")) app.Invoke(() => ShowWindow(app.Hwnd, 4)); // SW_SHOWNOACTIVATE
        if (c.ContainsKey("title")) { string t = Convert.ToString(c["title"]); app.Invoke(() => app.SetTitle(t)); }
        if (c.ContainsKey("set")) foreach (var kv in (Dictionary<string, object>)c["set"]) { var k = kv.Key; var v = Convert.ToString(kv.Value); app.Invoke(() => app.Set(k, v)); }
        if (c.ContainsKey("select")) { string s = Convert.ToString(c["select"]); app.Invoke(() => app.Focus(s)); }
        if (c.ContainsKey("selectText")) {
          var st = (Dictionary<string, object>)c["selectText"];
          string nm = Convert.ToString(st["name"]); int a = Convert.ToInt32(st["start"]), l = Convert.ToInt32(st["length"]);
          app.Invoke(() => app.SelectText(nm, a, l));
        }
        if (c.ContainsKey("topmost")) { bool on = Convert.ToBoolean(c["topmost"]); app.Invoke(() => SetWindowPos(app.Hwnd, new IntPtr(on ? -1 : -2), 0, 0, 0, 0, 0x0013)); } // SWP_NOSIZE|NOMOVE|NOACTIVATE
        if (c.ContainsKey("rect")) { string nm = Convert.ToString(c["rect"]); Dictionary<string, object> r = null; app.Invoke(() => r = app.RectOf(nm)); Emit(D("rect", r)); }
        if (c.ContainsKey("state")) {
          Dictionary<string, object> s = null;
          app.Invoke(() => { s = app.State(); s["active"] = GetForegroundWindow() == app.Hwnd; s["min"] = IsIconic(app.Hwnd); });
          Emit(D("state", s));
        }
      } catch (Exception e) { Emit(D("error", e.Message)); }
      Emit(D("ok", n));
    }
    app.Quit();
    return 0;
  }

  // ---------------- WinForms (classic Win32 controls) ----------------
  class NoActivateForm : System.Windows.Forms.Form {
    protected override bool ShowWithoutActivation { get { return true; } }
  }

  class FormsApp : IApp {
    NoActivateForm form;
    System.Windows.Forms.TextBox message, notes;
    System.Windows.Forms.CheckBox agree;
    System.Windows.Forms.ListBox channels;
    System.Windows.Forms.Label status;
    IntPtr hwnd;
    public IntPtr Hwnd { get { return hwnd; } }

    public FormsApp(string title, bool onscreen, ManualResetEvent ready) {
      app = this;
      System.Windows.Forms.Application.EnableVisualStyles();
      form = new NoActivateForm { Text = title, Width = 640, Height = 420, StartPosition = System.Windows.Forms.FormStartPosition.Manual, Left = onscreen ? 80 : -5200, Top = 120 };
      message = new System.Windows.Forms.TextBox { Name = "Message", AccessibleName = "Message", Left = 12, Top = 12, Width = 400 };
      notes = new System.Windows.Forms.TextBox { Name = "Notes", AccessibleName = "Notes", Left = 12, Top = 44, Width = 400, Height = 120, Multiline = true, Text = "First line of notes\r\nSecond line" };
      var send = new System.Windows.Forms.Button { Name = "Send", Text = "Send", AccessibleName = "Send", Left = 420, Top = 10, Width = 90 };
      var save = new System.Windows.Forms.Button { Name = "Save", Text = "Save", AccessibleName = "Save", Left = 420, Top = 44, Width = 90 };
      agree = new System.Windows.Forms.CheckBox { Name = "Agree", Text = "Agree", AccessibleName = "Agree", Left = 12, Top = 176, Width = 120 };
      channels = new System.Windows.Forms.ListBox { Name = "Channels", AccessibleName = "Channels", Left = 12, Top = 206, Width = 200, Height = 80 };
      channels.Items.AddRange(new object[] { "general", "random", "help" });
      status = new System.Windows.Forms.Label { Name = "Status", Text = "Ready", AccessibleName = "Status", Left = 12, Top = 300, Width = 400 };
      var secret = new System.Windows.Forms.TextBox { Name = "Secret", AccessibleName = "Secret", Left = 220, Top = 206, Width = 180, UseSystemPasswordChar = true, Text = "hunter2-secret" };
      send.Click += (s, e) => Emit(D("event", "click", "name", "Send"));
      save.Click += (s, e) => Emit(D("event", "click", "name", "Save"));
      message.TextChanged += (s, e) => Emit(D("event", "text", "name", "Message", "value", message.Text));
      notes.TextChanged += (s, e) => Emit(D("event", "text", "name", "Notes", "value", notes.Text));
      agree.CheckedChanged += (s, e) => Emit(D("event", "check", "name", "Agree", "value", agree.Checked));
      channels.SelectedIndexChanged += (s, e) => Emit(D("event", "select", "name", "Channels", "value", Convert.ToString(channels.SelectedItem)));
      form.Activated += (s, e) => Emit(D("event", "activated"));
      form.Deactivate += (s, e) => Emit(D("event", "deactivated"));
      form.Controls.AddRange(new System.Windows.Forms.Control[] { message, notes, send, save, agree, channels, secret, status });
      form.Shown += (s, e) => { hwnd = form.Handle; ready.Set(); };
      form.Show();
      System.Windows.Forms.Application.Run(form);
    }
    public void Invoke(Action a) { form.Invoke(a); }
    public void SetTitle(string t) { form.Text = t; }
    System.Windows.Forms.TextBox Box(string name) { return name == "Notes" ? notes : message; }
    public void Set(string name, string value) { Box(name).Text = value; }
    public void SelectText(string name, int start, int length) { var b = Box(name); b.Select(start, length); }
    public void Focus(string name) { Box(name).Focus(); }
    public Dictionary<string, object> State() {
      return D("Message", message.Text, "Notes", notes.Text, "Agree", agree.Checked, "Channel", Convert.ToString(channels.SelectedItem ?? ""));
    }
    public Dictionary<string, object> RectOf(string name) {
      var c = form.Controls[name];
      if (c == null) return null;
      var r = c.Parent.RectangleToScreen(c.Bounds);
      return D("name", name, "x", r.X, "y", r.Y, "w", r.Width, "h", r.Height);
    }
    public void Quit() { try { form.Invoke((Action)(() => form.Close())); } catch { } }
  }

  // ---------------- WPF (UI Automation patterns) ----------------
  class WpfApp : IApp {
    System.Windows.Window win;
    System.Windows.Controls.TextBox message, notes;
    System.Windows.Controls.CheckBox agree;
    System.Windows.Controls.ListBox channels;
    readonly Dictionary<string, System.Windows.FrameworkElement> named = new Dictionary<string, System.Windows.FrameworkElement>();
    IntPtr hwnd;
    public IntPtr Hwnd { get { return hwnd; } }

    public WpfApp(string title, bool onscreen, ManualResetEvent ready) {
      app = this;
      var a = new System.Windows.Application { ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown };
      win = new System.Windows.Window { Title = title, Width = 640, Height = 420, Left = onscreen ? 80 : -5200, Top = 120, ShowActivated = false };
      var panel = new System.Windows.Controls.StackPanel();
      message = new System.Windows.Controls.TextBox { Width = 400, Margin = new System.Windows.Thickness(8) };
      notes = new System.Windows.Controls.TextBox { Width = 400, Height = 90, AcceptsReturn = true, Text = "First line of notes\r\nSecond line", Margin = new System.Windows.Thickness(8) };
      var send = new System.Windows.Controls.Button { Content = "Send", Width = 90 };
      var save = new System.Windows.Controls.Button { Content = "Save", Width = 90 };
      agree = new System.Windows.Controls.CheckBox { Content = "Agree" };
      channels = new System.Windows.Controls.ListBox { Width = 200, Height = 70 };
      foreach (var ch in new[] { "general", "random", "help" }) channels.Items.Add(new System.Windows.Controls.ListBoxItem { Content = ch });
      var status = new System.Windows.Controls.TextBlock { Text = "Ready" };
      var secret = new System.Windows.Controls.PasswordBox { Password = "hunter2-secret", Width = 180 };
      System.Windows.Automation.AutomationProperties.SetName(secret, "Secret");
      System.Windows.Automation.AutomationProperties.SetName(message, "Message");
      System.Windows.Automation.AutomationProperties.SetName(notes, "Notes");
      System.Windows.Automation.AutomationProperties.SetName(channels, "Channels");
      System.Windows.Automation.AutomationProperties.SetName(status, "Status");
      send.Click += (s, e) => Emit(D("event", "click", "name", "Send"));
      save.Click += (s, e) => Emit(D("event", "click", "name", "Save"));
      message.TextChanged += (s, e) => Emit(D("event", "text", "name", "Message", "value", message.Text));
      notes.TextChanged += (s, e) => Emit(D("event", "text", "name", "Notes", "value", notes.Text));
      agree.Checked += (s, e) => Emit(D("event", "check", "name", "Agree", "value", true));
      agree.Unchecked += (s, e) => Emit(D("event", "check", "name", "Agree", "value", false));
      channels.SelectionChanged += (s, e) => Emit(D("event", "select", "name", "Channels", "value", Convert.ToString(((System.Windows.Controls.ListBoxItem)channels.SelectedItem).Content)));
      win.Activated += (s, e) => Emit(D("event", "activated"));
      win.Deactivated += (s, e) => Emit(D("event", "deactivated"));
      foreach (System.Windows.UIElement el in new System.Windows.UIElement[] { message, notes, send, save, agree, channels, secret, status }) panel.Children.Add(el);
      win.Content = panel;
      named["Message"] = message; named["Notes"] = notes; named["Send"] = send; named["Save"] = save; named["Agree"] = agree; named["Channels"] = channels;
      win.Show();
      hwnd = new System.Windows.Interop.WindowInteropHelper(win).Handle;
      ready.Set();
      a.Run();
    }
    public void Invoke(Action a) { win.Dispatcher.Invoke(a); }
    public void SetTitle(string t) { win.Title = t; }
    System.Windows.Controls.TextBox Box(string name) { return name == "Notes" ? notes : message; }
    public void Set(string name, string value) { Box(name).Text = value; }
    // No focus at all: Focus() (even logical focus) would activate the window, and the fixture must
    // never take focus. A WPF text box keeps its selection while unfocused.
    public void SelectText(string name, int start, int length) { var b = Box(name); b.Select(start, length); }
    public void Focus(string name) { System.Windows.Input.FocusManager.SetFocusedElement(win, Box(name)); }
    public Dictionary<string, object> State() {
      var item = channels.SelectedItem as System.Windows.Controls.ListBoxItem;
      return D("Message", message.Text, "Notes", notes.Text, "Agree", agree.IsChecked == true, "Channel", item == null ? "" : Convert.ToString(item.Content));
    }
    public Dictionary<string, object> RectOf(string name) {
      System.Windows.FrameworkElement el;
      if (!named.TryGetValue(name, out el)) return null;
      var a = el.PointToScreen(new System.Windows.Point(0, 0));
      var b = el.PointToScreen(new System.Windows.Point(el.ActualWidth, el.ActualHeight));
      return D("name", name, "x", (int)Math.Round(a.X), "y", (int)Math.Round(a.Y), "w", (int)Math.Round(b.X - a.X), "h", (int)Math.Round(b.Y - a.Y));
    }
    public void Quit() { try { win.Dispatcher.Invoke(() => System.Windows.Application.Current.Shutdown()); } catch { } }
  }
}
