# Talks to the Claude desktop window through Windows UI Automation (the accessibility API).
# It never moves the mouse, presses keys, steals focus or touches the clipboard.
#   -Mode info   : which session is open, and whether its prompt box has text
#   -Mode list   : the sessions listed in Claude's sidebar
#   -Mode switch : open a sidebar session by title (-TitleB64)
#   -Mode send   : fill the prompt box (-TextB64) and press Claude's Send button.
#                  -ExpectTitleB64 refuses unless that session is the one open.
#                  -DryRun fills the box, checks it, then clears it again without sending.
# Always prints one line of JSON.
param(
  [ValidateSet('info', 'list', 'switch', 'send')][string]$Mode = 'info',
  [string]$TextB64 = '',
  [string]$TitleB64 = '',
  [string]$ExpectTitleB64 = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 5; exit 0 }
function Decode($b64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }

$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$ButtonCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)

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

# Claude's Send button appears next to the prompt box once it has text.
function Get-SendButton($root, $box) {
  $boxRect = $box.Current.BoundingRectangle
  $best = $null
  $bestDist = [double]::MaxValue
  foreach ($b in $root.FindAll($Scope::Descendants, $ButtonCond)) {
    $c = $b.Current
    if ($c.Name -ne 'Send' -or -not $c.IsEnabled) { continue }
    $r = $c.BoundingRectangle
    $dist = [Math]::Abs(($r.Y + $r.Height / 2) - ($boxRect.Y + $boxRect.Height / 2)) + [Math]::Abs($r.X - $boxRect.Right)
    if ($dist -lt $bestDist) { $best = $b; $bestDist = $dist }
  }
  return $best
}

# Claude's sidebar shows each session as a button, next to a "More options for <title>" button.
# Returns @{ title; button; label } for each one, in sidebar order.
function Get-SidebarSessions($root) {
  $buttons = $root.FindAll($Scope::Descendants, $ButtonCond)
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
    foreach ($s in $parent.FindAll($Scope::Children, $ButtonCond)) {
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

try {
  $proc = Find-ClaudeWindow
  if (-not $proc) { Out-Json @{ ok = $false; error = 'claude_window_not_found'; message = 'The Claude desktop app is not open (or is minimized to the tray).' } }
  $root = $AE::FromHandle($proc.MainWindowHandle)
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
    if (-not $hit) { $hit = $all | Where-Object { $_.title.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1 }
    if (-not $hit) {
      Out-Json @{ ok = $false; error = 'session_not_in_sidebar'; message = "Couldn't find that session in Claude's sidebar. It may be archived or scrolled out of the list."; sessionTitle = $title }
    }
    $hit.button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 100
      $now = Get-SessionTitle $root
      if ($now -eq $hit.title) { Out-Json @{ ok = $true; switched = $true; sessionTitle = $now } }
    }
    Out-Json @{ ok = $false; error = 'switch_not_confirmed'; message = "Clicked the session in the sidebar, but the window didn't confirm the switch."; sessionTitle = (Get-SessionTitle $root) }
  }

  # ---- send ----
  $box = Get-PromptBox $root
  if (-not $box) { Out-Json @{ ok = $false; error = 'prompt_box_not_found'; message = 'No prompt box is visible. Open a Code session in the Claude app.'; sessionTitle = $title } }
  if ($ExpectTitleB64) {
    $expect = Decode $ExpectTitleB64
    if ($title -ne $expect) { Out-Json @{ ok = $false; error = 'session_changed'; message = 'A different session is open now than the one this prompt was drafted for, so nothing was sent.'; sessionTitle = $title } }
  }
  $text = Decode $TextB64
  if (-not $text.Trim()) { Out-Json @{ ok = $false; error = 'empty_text' } }
  if (Get-BoxText $box) { Out-Json @{ ok = $false; error = 'prompt_box_not_empty'; message = 'The prompt box already has text in it, so nothing was sent (to avoid wiping a draft).'; sessionTitle = $title } }

  $vp = $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if ($vp.Current.IsReadOnly) { Out-Json @{ ok = $false; error = 'prompt_box_read_only'; message = "Claude's prompt box isn't accepting input right now."; sessionTitle = $title } }
  $vp.SetValue($text)
  Start-Sleep -Milliseconds 250

  $landed = Get-BoxText $box
  $probe = ($text.Trim() -split "`n")[0].Trim()
  if ($probe.Length -gt 30) { $probe = $probe.Substring(0, 30) }
  if (-not ($landed -and $landed.Contains($probe))) {
    try { $vp.SetValue('') } catch {}
    Out-Json @{ ok = $false; error = 'fill_not_verified'; message = "Couldn't confirm the text reached Claude's prompt box, so nothing was sent."; sessionTitle = $title }
  }

  if ($DryRun) {
    $vp.SetValue('')
    Out-Json @{ ok = $true; sent = $false; dryRun = $true; sessionTitle = $title }
  }

  $send = Get-SendButton $root $box
  if (-not $send) {
    try { $vp.SetValue('') } catch {}
    Out-Json @{ ok = $false; error = 'send_button_not_found'; message = "Couldn't find Claude's Send button, so nothing was sent."; sessionTitle = $title }
  }
  $send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()

  # Claude empties the box once it accepts the message.
  $confirmed = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 100
    if (-not (Get-BoxText $box)) { $confirmed = $true; break }
  }
  Out-Json @{ ok = $true; sent = $true; confirmed = $confirmed; sessionTitle = $title }
} catch {
  Out-Json @{ ok = $false; error = 'script_exception'; message = "$($_.Exception.Message)" }
}
