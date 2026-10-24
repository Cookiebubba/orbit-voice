// orbit-jail: runs one local MCP server (or any command) boxed in ("Orbit anywhere", phase 9):
//   - inside a Job Object: killed the moment Orbit (or this launcher) goes, at most 2 GB of memory
//     per process and 64 processes, no breaking away;
//   - at low integrity (Windows' "Low" mandatory label, like a browser sandbox): it can't write to
//     the user's files or other programs' memory, only to its own LocalLow folder.
// The server talks over this launcher's own stdin/stdout (the handles are passed straight to it),
// so it speaks MCP to Orbit (or Claude Code) as if run directly. Exit code: the server's.
//
// Usage: orbit-jail.exe [--medium] [--mem-mb N] -- <command line>
// Built at runtime with .NET Framework's csc (src/mcp/sandbox.js), cached per version.
using System;
using System.Runtime.InteropServices;
using System.Text;

static class OrbitJail {
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr sa, int level, int type, out IntPtr dup);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref TOKEN_MANDATORY_LABEL tml, int size);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string sid, out IntPtr psid);
  [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr psid);

  const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, CREATE_UNICODE_ENVIRONMENT = 0x400;
  const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8, JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
  const int JobObjectExtendedLimitInformation = 9, TokenIntegrityLevel = 25;
  const uint TOKEN_DUPLICATE = 0x2, TOKEN_QUERY = 0x8, TOKEN_ASSIGN_PRIMARY = 0x1, TOKEN_ADJUST_DEFAULT = 0x80, SE_GROUP_INTEGRITY = 0x20;

  static int Main(string[] args) {
    bool medium = false; ulong memMb = 2048;
    int i = 0;
    for (; i < args.Length && args[i] != "--"; i++) {
      if (args[i] == "--medium") medium = true;
      else if (args[i] == "--mem-mb" && i + 1 < args.Length) memMb = ulong.Parse(args[++i]);
    }
    if (i + 1 >= args.Length) { Console.Error.WriteLine("orbit-jail: no command"); return 120; }
    // The command line after "--", re-quoted.
    StringBuilder cmd = new StringBuilder();
    for (int k = i + 1; k < args.Length; k++) { if (cmd.Length > 0) cmd.Append(' '); cmd.Append(Quote(args[k])); }

    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    info.BasicLimitInformation.ActiveProcessLimit = 64;
    info.ProcessMemoryLimit = new UIntPtr(memMb * 1024 * 1024);
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(info))) { Console.Error.WriteLine("orbit-jail: job limits refused"); return 121; }

    // Pass our own stdin/stdout/stderr straight to the server.
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    si.dwFlags = 0x100; // STARTF_USESTDHANDLES
    si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
    foreach (IntPtr h in new[] { si.hStdInput, si.hStdOutput, si.hStdError }) SetHandleInformation(h, 1, 1);
    PROCESS_INFORMATION pi;
    uint flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
    bool ok;
    if (medium) {
      ok = CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi);
    } else {
      IntPtr tok, low, sid;
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, out tok)) { Console.Error.WriteLine("orbit-jail: no token"); return 122; }
      if (!DuplicateTokenEx(tok, 0x02000000, IntPtr.Zero, 2, 1, out low)) { Console.Error.WriteLine("orbit-jail: no token copy"); return 122; }
      ConvertStringSidToSid("S-1-16-4096", out sid); // Low mandatory level
      var tml = new TOKEN_MANDATORY_LABEL();
      tml.Label.Sid = sid; tml.Label.Attributes = SE_GROUP_INTEGRITY;
      if (!SetTokenInformation(low, TokenIntegrityLevel, ref tml, Marshal.SizeOf(tml) + GetLengthSid(sid))) { Console.Error.WriteLine("orbit-jail: could not lower integrity"); return 123; }
      ok = CreateProcessAsUser(low, null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi);
    }
    if (!ok) { Console.Error.WriteLine("orbit-jail: could not start (" + Marshal.GetLastWin32Error() + ")"); return 124; }
    if (!AssignProcessToJobObject(job, pi.hProcess)) { Console.Error.WriteLine("orbit-jail: not boxed"); return 125; }
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return (int)code; // the job closes with us: anything the server left running ends too
  }

  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
    StringBuilder b = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in a) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); slashes = 0; continue; }
      b.Append('\\', slashes); slashes = 0; b.Append(c);
    }
    b.Append('\\', slashes * 2);
    return b.Append('"').ToString();
  }
}
