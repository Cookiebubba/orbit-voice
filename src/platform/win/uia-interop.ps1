# The COM UI Automation interfaces (CUIAutomation8, IUIAutomation2: AutoSetFocus can be turned off)
# as a .NET interop assembly, converted from Windows' own type library (UIAutomationCore.dll) once
# per UIAutomationCore version and kept in the cache, so nothing is shipped. Dot-sourced by
# desktop.ps1 (the Claude window).

# Path of Interop.UIAutomationClient.dll in <Cache>\uia-<version> (made first if it isn't there).
function Get-UiaInterop([string]$Cache) {
  $core = Join-Path $env:SystemRoot 'System32\UIAutomationCore.dll'
  $ver = ((Get-Item $core).VersionInfo.FileVersion -replace '[^0-9A-Za-z.]', '_')
  if (-not $Cache) { $Cache = Join-Path $env:LOCALAPPDATA 'Orbit\cache' }
  $dir = Join-Path $Cache "uia-$ver"
  $dll = Join-Path $dir 'Interop.UIAutomationClient.dll'
  if (Test-Path $dll) { return $dll }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = Join-Path $dir ("tmp-" + $PID)
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  if (-not ('OrbitTlb' -as [type])) {
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
  }
  $here = [Environment]::CurrentDirectory
  [Environment]::CurrentDirectory = $tmp
  try { [OrbitTlb]::Make($core, $tmp) } finally { [Environment]::CurrentDirectory = $here }
  try { Move-Item -Path (Join-Path $tmp 'Interop.UIAutomationClient.dll') -Destination $dll -ErrorAction Stop } catch { if (-not (Test-Path $dll)) { throw } }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  return $dll
}
