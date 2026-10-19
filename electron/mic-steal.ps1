# "Mute my mic in other apps while Grok listens". Mutes other programs' microphone streams
# (Windows Core Audio capture sessions: Discord, Zoom, Teams, games...) while Grok has the mic,
# and unmutes exactly the ones it muted afterwards. Orbit's own stream is never touched. Apps keep
# running and their own mute buttons are unchanged; they simply receive silence.
#
# Commands on stdin, one per line:
#   steal     mute other apps' mic streams now, and any that start while stealing (checked every second)
#   release   unmute the streams this helper muted
#   list      print every mic stream as JSON (for Settings and tests)
#   rules<TAB><mute|leave><TAB><exe>|...<TAB><exe>|...
#             what to do with apps by default, which to always mute, which to always leave alone
#             (see src/mic-apps.js); applied at once if stealing
# Prints one JSON line per command result. On exit (stdin closed: Orbit quit or crashed) it releases.
# What it muted is written to -StateFile, so a later run (-Recover) can undo it after a hard crash.
param(
  [string]$OwnExe = '',       # Orbit's executable: streams from it (any of its processes) are skipped
  [string]$StateFile = '',
  [string]$OnlyExe = '',      # tests only: touch nothing but streams from this executable
  [switch]$Recover            # unmute anything a previous run left muted, then exit
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace OrbitMic {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr guid, int flags, out IntPtr ctl);
    int GetSimpleAudioVolume(IntPtr guid, int flags, out IntPtr vol);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl2 session);
  }
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName(out IntPtr name);
    int SetDisplayName(IntPtr name, IntPtr ctx);
    int GetIconPath(out IntPtr path);
    int SetIconPath(IntPtr path, IntPtr ctx);
    int GetGroupingParam(out Guid param);
    int SetGroupingParam(IntPtr param, IntPtr ctx);
    int RegisterAudioSessionNotification(IntPtr n);
    int UnregisterAudioSessionNotification(IntPtr n);
    int GetSessionIdentifier(out IntPtr id);
    int GetSessionInstanceIdentifier(out IntPtr id);
    int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
  }
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    int SetMasterVolume(float level, ref Guid ctx);
    int GetMasterVolume(out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  public class Session {
    public string Id;        // stable per app + device (used to restore)
    public string Instance;  // this stream only
    public uint Pid;
    public string Exe;
    public string Name;      // the program's own description ("Discord"), for Settings
    public bool Muted;
    public bool Active;
    internal ISimpleAudioVolume Volume;
  }

  public static class Steal {
    static Guid ctx = new Guid("6f6b8a4e-0b6e-4d0b-9a3e-5e0f2b0c0b17"); // marks changes as Orbit's
    static readonly HashSet<string> mine = new HashSet<string>(); // session ids this helper muted
    public static string OwnExe = "", OnlyExe = "", StateFile = "";
    // The user's choice (src/mic-apps.js): what to do with apps not listed, and the listed ones.
    static bool defaultMute = true;
    static HashSet<string> alwaysMute = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static HashSet<string> alwaysLeave = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    /** "rules\t<mute|leave>\t<exe>|<exe>...\t<exe>|<exe>..." Returns false if malformed. */
    public static bool SetRules(string line) {
      string[] p = line.Split('\t');
      if (p.Length != 4 || (p[1] != "mute" && p[1] != "leave")) return false;
      defaultMute = p[1] == "mute";
      alwaysMute = new HashSet<string>(p[2].Split(new[] { '|' }, StringSplitOptions.RemoveEmptyEntries), StringComparer.OrdinalIgnoreCase);
      alwaysLeave = new HashSet<string>(p[3].Split(new[] { '|' }, StringSplitOptions.RemoveEmptyEntries), StringComparer.OrdinalIgnoreCase);
      return true;
    }

    static string NameOf(string exe) {
      if (exe.Length == 0) return "";
      try { string d = FileVersionInfo.GetVersionInfo(exe).FileDescription; if (!string.IsNullOrEmpty(d) && d.Trim().Length > 0) return d.Trim(); } catch { }
      return Path.GetFileNameWithoutExtension(exe);
    }

    static string Take(IntPtr p) { if (p == IntPtr.Zero) return ""; string s = Marshal.PtrToStringUni(p); Marshal.FreeCoTaskMem(p); return s; }

    static string ExeOf(uint pid) {
      try { return Process.GetProcessById((int)pid).MainModule.FileName; } catch { return ""; }
    }

    public static List<Session> Sessions() {
      var list = new List<Session>();
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
      IMMDeviceCollection devices;
      en.EnumAudioEndpoints(1 /* capture */, 1 /* active */, out devices);
      int n; devices.GetCount(out n);
      Guid iid = typeof(IAudioSessionManager2).GUID;
      for (int i = 0; i < n; i++) {
        IMMDevice dev; devices.Item(i, out dev);
        object o; dev.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o);
        var mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator sessions; mgr.GetSessionEnumerator(out sessions);
        int count; sessions.GetCount(out count);
        for (int j = 0; j < count; j++) {
          IAudioSessionControl2 c; sessions.GetSession(j, out c);
          if (c.IsSystemSoundsSession() == 0) continue;
          int state; c.GetState(out state);
          if (state == 2) continue; // expired
          IntPtr idp, instp; c.GetSessionIdentifier(out idp); c.GetSessionInstanceIdentifier(out instp);
          uint pid; c.GetProcessId(out pid);
          var vol = (ISimpleAudioVolume)c;
          bool muted; vol.GetMute(out muted);
          string exe = ExeOf(pid);
          list.Add(new Session { Id = Take(idp), Instance = Take(instp), Pid = pid, Exe = exe, Name = NameOf(exe), Muted = muted, Active = state == 1, Volume = vol });
        }
      }
      return list;
    }

    static bool Eligible(Session s) {
      if (s.Pid == 0) return false;
      if (OnlyExe.Length > 0) return string.Equals(s.Exe, OnlyExe, StringComparison.OrdinalIgnoreCase);
      if (OwnExe.Length > 0 && string.Equals(s.Exe, OwnExe, StringComparison.OrdinalIgnoreCase)) return false; // Orbit itself
      string file = s.Exe.Length > 0 ? Path.GetFileName(s.Exe) : "";
      if (alwaysMute.Contains(file)) return true;
      if (alwaysLeave.Contains(file)) return false;
      return defaultMute; // includes apps whose program we can't see (e.g. running as administrator)
    }

    /** Mutes every eligible stream that isn't muted yet. Returns how many it muted this time. */
    public static int Mute() {
      int changed = 0;
      foreach (var s in Sessions()) {
        if (!Eligible(s) || s.Muted) continue;
        s.Volume.SetMute(true, ref ctx);
        mine.Add(s.Id);
        changed++;
      }
      if (changed > 0) Save();
      return changed;
    }

    /** Unmutes the streams this helper muted (or, recovering, the ones a previous run recorded). */
    public static int Unmute() {
      int changed = 0;
      if (mine.Count == 0) return 0;
      foreach (var s in Sessions()) {
        if (!mine.Contains(s.Id) || !s.Muted) continue;
        s.Volume.SetMute(false, ref ctx);
        changed++;
      }
      mine.Clear();
      Save();
      return changed;
    }

    public static void Load() {
      if (StateFile.Length == 0 || !File.Exists(StateFile)) return;
      foreach (var line in File.ReadAllLines(StateFile)) if (line.Trim().Length > 0) mine.Add(line.Trim());
    }

    static void Save() {
      if (StateFile.Length == 0) return;
      if (mine.Count == 0) { try { File.Delete(StateFile); } catch { } return; }
      File.WriteAllLines(StateFile, new List<string>(mine).ToArray());
    }

    /** Commands from stdin, read on a background thread; "exit" when stdin closes. */
    public static readonly System.Collections.Concurrent.ConcurrentQueue<string> Commands = new System.Collections.Concurrent.ConcurrentQueue<string>();
    public static void StartReader() {
      var t = new System.Threading.Thread(delegate () {
        string line;
        while ((line = Console.In.ReadLine()) != null) Commands.Enqueue(line.Trim(' ', '\r', '\n')); // keep tabs: they separate the rules
        Commands.Enqueue("exit");
      });
      t.IsBackground = true;
      t.Start();
    }

    public static string Json(string s) {
      var b = new StringBuilder("\"");
      foreach (char ch in s ?? "") { if (ch == '"' || ch == '\\') b.Append('\\').Append(ch); else if (ch < ' ') b.Append(' '); else b.Append(ch); }
      return b.Append('"').ToString();
    }
  }
}
'@

[OrbitMic.Steal]::OwnExe = $OwnExe
[OrbitMic.Steal]::OnlyExe = $OnlyExe
[OrbitMic.Steal]::StateFile = $StateFile
[OrbitMic.Steal]::Load()

if ($Recover) {
  $n = [OrbitMic.Steal]::Unmute()
  [Console]::Out.WriteLine('{"recovered":' + $n + '}')
  exit 0
}

# stdin is read on a background thread so the main loop can re-mute new streams every second.
[OrbitMic.Steal]::StartReader()
$queue = [OrbitMic.Steal]::Commands

$stealing = $false
$tick = [Diagnostics.Stopwatch]::StartNew()
function Say($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
try {
  while ($true) {
    $cmd = $null
    while ($queue.TryDequeue([ref]$cmd)) {
      switch ($cmd) {
        'steal' { $stealing = $true; Say ('{"stealing":true,"muted":' + [OrbitMic.Steal]::Mute() + '}') }
        'release' { $stealing = $false; Say ('{"stealing":false,"unmuted":' + [OrbitMic.Steal]::Unmute() + '}') }
        'list' {
          $items = [OrbitMic.Steal]::Sessions() | ForEach-Object { '{"pid":' + $_.Pid + ',"exe":' + [OrbitMic.Steal]::Json($_.Exe) + ',"name":' + [OrbitMic.Steal]::Json($_.Name) + ',"muted":' + $_.Muted.ToString().ToLower() + ',"active":' + $_.Active.ToString().ToLower() + '}' }
          Say ('{"sessions":[' + ($items -join ',') + ']}')
        }
        { $_ -like "rules`t*" } {
          if (-not [OrbitMic.Steal]::SetRules($cmd)) { Say '{"error":"bad rules"}'; break }
          if ($stealing) { [void][OrbitMic.Steal]::Unmute(); [void][OrbitMic.Steal]::Mute() } # re-apply: give back what's now left alone
          Say ('{"rules":true,"stealing":' + $stealing.ToString().ToLower() + '}')
        }
        'exit' { return }
      }
    }
    if ($stealing -and $tick.ElapsedMilliseconds -ge 1000) {
      $tick.Restart()
      $n = [OrbitMic.Steal]::Mute() # a stream that started meanwhile (Discord rejoined, a new app)
      if ($n) { Say ('{"stealing":true,"muted":' + $n + '}') }
    }
    Start-Sleep -Milliseconds 100
  }
} finally {
  [void][OrbitMic.Steal]::Unmute() # Orbit quit or crashed: give every app its mic back
}
