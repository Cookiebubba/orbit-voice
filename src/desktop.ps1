# Talks to the Claude desktop window through Windows UI Automation (the accessibility API).
#   -Mode info   : which session is open, and whether its prompt box has text
#   -Mode list   : the sessions listed in Claude's sidebar
#   -Mode switch : open a sidebar session by title (-TitleB64), without moving the mouse
#   -Mode send   : put text into the prompt box and press Enter
#                  (-DryRun pastes, checks it landed, then clears it again without sending)
# Always prints one line of JSON.
param(
  [ValidateSet('info', 'list', 'switch', 'send')][string]$Mode = 'info',
  [string]$TextB64 = '',
  [string]$TitleB64 = '',
  [switch]$DryRun,
  [switch]$ReturnFocus
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 5; exit 0 }
function Decode($b64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }

$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

function Find-ClaudeWindow {
  Get-Process -Name 'claude' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like 'Claude*' } |
    Select-Object -First 1
}

function Get-SessionTitle($root) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Document)
  foreach ($d in $root.FindAll($Scope::Descendants, $cond)) {
    $n = $d.Current.Name
    if ($n -like '* - Claude Code') { return $n.Substring(0, $n.Length - ' - Claude Code'.Length) }
  }
  return $null
}

function Get-PromptBox($root) {
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)),
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Prompt')))
  $boxes = $root.FindAll($Scope::Descendants, $cond)
  if ($boxes.Count -eq 0) { return $null }
  # In split view there can be more than one; prefer the one that has keyboard focus.
  foreach ($b in $boxes) { if ($b.Current.HasKeyboardFocus) { return $b } }
  return $boxes[0]
}

function Get-BoxText($box) {
  try {
    $vp = $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return ($vp.Current.Value -replace '\s+$', '')
  } catch { return '' }
}

# Claude's sidebar shows each session as a button, next to a "More options for <title>" button.
# Returns @{ title; button } for each one, in sidebar order.
function Get-SidebarSessions($root) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
  $buttons = $root.FindAll($Scope::Descendants, $cond)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $seen = @{}
  $out = New-Object System.Collections.ArrayList
  foreach ($b in $buttons) {
    $n = $b.Current.Name
    if (-not $n -or -not $n.StartsWith('More options for ')) { continue }
    $t = $n.Substring('More options for '.Length)
    if ($seen.ContainsKey($t)) { continue }
    # The session button is a sibling in the same group whose name starts with the title.
    $parent = $walker.GetParent($b)
    if (-not $parent) { continue }
    $match = $null
    foreach ($s in $parent.FindAll($Scope::Children, $cond)) {
      $sn = $s.Current.Name
      if ($sn -and ($sn -eq $t -or $sn.StartsWith("$t ")) -and -not $sn.StartsWith('More options')) {
        $pattern = $null
        if ($s.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $match = $s; break }
      }
    }
    if ($match) {
      $seen[$t] = $true
      [void]$out.Add(@{ title = $t; button = $match; label = $match.Current.Name })
    }
  }
  return $out
}

# Bring a window to the front. Windows only lets the current foreground app hand focus away, so
# we briefly share its input queue. (No Alt-key trick: Claude's window would open its menu bar.)
function Focus-Window([IntPtr]$h) {
  if ([Win]::IsIconic($h)) { [Win]::ShowWindow($h, 9) | Out-Null }  # SW_RESTORE
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    $fg = [Win]::GetForegroundWindow()
    if ($fg -eq $h) { return $true }
    $fgThread = [Win]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $me = [Win]::GetCurrentThreadId()
    [Win]::AttachThreadInput($me, $fgThread, $true) | Out-Null
    if ($attempt -eq 1) {
      # Second try: a harmless key event (F24, which nothing uses) counts as user input.
      [Win]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [Win]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero)
    }
    [Win]::BringWindowToTop($h) | Out-Null
    [Win]::SetForegroundWindow($h) | Out-Null
    [Win]::AttachThreadInput($me, $fgThread, $false) | Out-Null
    Start-Sleep -Milliseconds 120
  }
  return ([Win]::GetForegroundWindow() -eq $h)
}

try {
  $proc = Find-ClaudeWindow
  if (-not $proc) { Out-Json @{ ok = $false; error = 'claude_window_not_found'; message = 'The Claude desktop app is not open (or is minimized to the tray).' } }
  $hwnd = $proc.MainWindowHandle
  $root = $AE::FromHandle($hwnd)
  $title = Get-SessionTitle $root

  # ---- info ----
  if ($Mode -eq 'info') {
    $box = Get-PromptBox $root
    Out-Json @{ ok = $true; sessionTitle = $title; promptBoxFound = [bool]$box; promptText = $(if ($box) { Get-BoxText $box } else { $null }) }
  }

  # ---- list ----
  if ($Mode -eq 'list') {
    $list = @(Get-SidebarSessions $root | ForEach-Object { @{ title = $_.title; label = $_.label; open = ($_.title -eq $title) } })
    Out-Json @{ ok = $true; sessionTitle = $title; sessions = $list }
  }

  # ---- switch ----
  if ($Mode -eq 'switch') {
    $want = (Decode $TitleB64).Trim()
    if (-not $want) { Out-Json @{ ok = $false; error = 'empty_title' } }
    if ($title -eq $want) { Out-Json @{ ok = $true; switched = $false; sessionTitle = $title; message = 'That session is already open.' } }
    $all = Get-SidebarSessions $root
    $hit = $all | Where-Object { $_.title -eq $want } | Select-Object -First 1
    if (-not $hit) { $hit = $all | Where-Object { $_.title -like "*$want*" } | Select-Object -First 1 }
    if (-not $hit) {
      Out-Json @{ ok = $false; error = 'session_not_in_sidebar'; message = "Couldn't find '$want' in Claude's sidebar. It may be archived or scrolled out of the list."; sessionTitle = $title; available = @($all | ForEach-Object { $_.title }) }
    }
    $hit.button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 100
      $now = Get-SessionTitle $root
      if ($now -eq $hit.title) { Out-Json @{ ok = $true; switched = $true; sessionTitle = $now } }
    }
    Out-Json @{ ok = $false; error = 'switch_not_confirmed'; message = "Clicked '$($hit.title)' in the sidebar, but the window didn't confirm the switch."; sessionTitle = (Get-SessionTitle $root) }
  }

  # ---- send ----
  $box = Get-PromptBox $root
  if (-not $box) { Out-Json @{ ok = $false; error = 'prompt_box_not_found'; message = 'No prompt box is visible. Open a Code session in the Claude app.'; sessionTitle = $title } }
  $text = Decode $TextB64
  if (-not $text.Trim()) { Out-Json @{ ok = $false; error = 'empty_text' } }

  $existing = Get-BoxText $box
  if ($existing) { Out-Json @{ ok = $false; error = 'prompt_box_not_empty'; message = 'The prompt box already has text in it, so nothing was sent (to avoid wiping a draft).'; sessionTitle = $title } }

  $previous = [Win]::GetForegroundWindow()
  if (-not (Focus-Window $hwnd)) { Out-Json @{ ok = $false; error = 'could_not_focus'; message = 'Windows would not bring the Claude window to the front.'; sessionTitle = $title } }
  $box.SetFocus()
  Start-Sleep -Milliseconds 80

  # Paste through the clipboard (fast, handles any characters), then put the old clipboard back.
  $savedClip = $null
  try { $savedClip = [System.Windows.Forms.Clipboard]::GetText() } catch {}
  [System.Windows.Forms.Clipboard]::SetText($text)
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 250

  $landed = Get-BoxText $box
  $probe = ($text.Trim() -split "`n")[0].Trim()
  if ($probe.Length -gt 30) { $probe = $probe.Substring(0, 30) }
  $ok = $landed -and $landed.Contains($probe)

  if ($ok -and -not $DryRun) {
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 200
  } elseif ($ok -and $DryRun) {
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait('{DELETE}')
  }

  if ($savedClip) { try { [System.Windows.Forms.Clipboard]::SetText($savedClip) } catch {} } else { try { [System.Windows.Forms.Clipboard]::Clear() } catch {} }
  if ($ReturnFocus -and $previous -ne [IntPtr]::Zero -and $previous -ne $hwnd) { Focus-Window $previous | Out-Null }

  if (-not $ok) { Out-Json @{ ok = $false; error = 'paste_not_verified'; message = 'Pasted, but could not confirm the text reached the prompt box, so Enter was not pressed.'; sessionTitle = $title } }
  Out-Json @{ ok = $true; sent = (-not $DryRun); dryRun = [bool]$DryRun; sessionTitle = $title }
} catch {
  Out-Json @{ ok = $false; error = 'script_exception'; message = "$($_.Exception.Message)" }
}
