# Talks to the Claude desktop window through Windows UI Automation (the accessibility API).
# It never moves the mouse, presses keys, steals focus or touches the clipboard.
#   -Mode info   : which session is open, and whether its prompt box has text
#   -Mode list   : the sessions listed in Claude's sidebar
#   -Mode switch : open a sidebar session by title (-TitleB64)
#   -Mode new    : press Claude's own "New" button in the sidebar (or "New session in <folder>"
#                  for -ProjectB64) and confirm an empty new-session prompt box appeared.
#                  Nothing is typed or sent; Claude creates the session with its first message.
#   -Mode send   : fill the prompt box (-TextB64) and press Claude's Send button.
#                  -ExpectTitleB64 refuses unless that session is the one open.
#                  -ExpectNew refuses unless a new, not yet started session is open
#                  (in folder -ExpectFolderB64, when given).
# Everything is looked up only inside Claude's own page, never in a web page shown in its window.
#                  -DryRun fills the box, checks it, then clears it again without sending.
# Always prints one line of JSON.
param(
  [ValidateSet('info', 'list', 'switch', 'new', 'send')][string]$Mode = 'info',
  [string]$TextB64 = '',
  [string]$TitleB64 = '',
  [string]$ExpectTitleB64 = '',
  [string]$ProjectB64 = '',
  [switch]$ExpectNew,
  [string]$ExpectFolderB64 = '',
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

$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$DocCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Document)
$SidebarCond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Group)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Sidebar')))

# Claude's own page inside its window. Web pages Claude shows (the Browser pane, previews, the Find
# bar) are separate documents, so nothing on them is ever read as Claude's title or pressed.
# It is the largest document that has Claude's sidebar; with the sidebar hidden, the largest one
# named like Claude's page.
function Find-AppDocument($win) {
  $best = $null; $bestScore = -1
  foreach ($d in $win.FindAll($Scope::Descendants, $DocCond)) {
    $c = $d.Current
    $r = $c.BoundingRectangle
    $area = if ($r.IsEmpty) { 0 } else { $r.Width * $r.Height }
    $named = $c.Name -eq 'Claude' -or $c.Name -like '* - Claude Code'
    $hasSidebar = [bool]$d.FindFirst($Scope::Descendants, $SidebarCond)
    if (-not $hasSidebar -and -not $named) { continue }
    $score = $(if ($hasSidebar) { 1e12 } else { 0 }) + $area
    if ($score -gt $bestScore) { $best = $d; $bestScore = $score }
  }
  return $best
}

# The nearest document an element belongs to.
function Get-OwnDocument($el) {
  $p = $el
  for ($i = 0; $p -and $i -lt 40; $i++) {
    if ($p.Current.ControlType -eq $CT::Document) { return $p }
    $p = $Walker.GetParent($p)
  }
  return $null
}

# Is this element part of Claude's own page (not of a web page or frame shown inside it)?
function Test-InApp($el) {
  $d = Get-OwnDocument $el
  return [bool]($d -and [System.Windows.Automation.Automation]::Compare($d, $script:App))
}

# The open session's title, from Claude's page title "<title> - Claude Code"; $null if none.
function Get-SessionTitle($root) {
  try { $n = $script:App.Current.Name } catch { $script:App = Find-AppDocument $script:Win; $n = $(if ($script:App) { $script:App.Current.Name } else { '' }) }
  if ($n -and $n.EndsWith(' - Claude Code') -and $n.Length -gt ' - Claude Code'.Length) { return $n.Substring(0, $n.Length - ' - Claude Code'.Length) }
  return $null
}

function Get-PromptBox($root) {
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)),
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Prompt')))
  $boxes = @($root.FindAll($Scope::Descendants, $cond) | Where-Object { Test-InApp $_ })
  if ($boxes.Count -eq 0) { return $null }
  # In split view there can be more than one; prefer the one that has keyboard focus.
  foreach ($b in $boxes) { if ($b.Current.HasKeyboardFocus) { return $b } }
  return $boxes[0]
}

function Get-BoxText($box) {
  try {
    $vp = $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $v = ($vp.Current.Value -replace '\s+$', '')
    # An empty box on a new-session page reports its "/" hint as its value.
    if ($v.Trim() -eq '/') { return '' }
    return $v
  } catch { return '' }
}

# Claude's Send button sits on the prompt box's row, at its right end.
function Get-SendButton($root, $box) {
  $boxRect = $box.Current.BoundingRectangle
  $best = $null
  $bestDist = [double]::MaxValue
  foreach ($b in $root.FindAll($Scope::Descendants, $ButtonCond)) {
    $c = $b.Current
    if ($c.Name -ne 'Send' -or -not $c.IsEnabled) { continue }
    $r = $c.BoundingRectangle
    $dy = [Math]::Abs(($r.Y + $r.Height / 2) - ($boxRect.Y + $boxRect.Height / 2))
    $dx = [Math]::Abs($r.X - $boxRect.Right)
    # Not a "Send" somewhere else on screen (or on a web page): same row, close to the box.
    if ($dy -gt 80 -or $r.X -lt $boxRect.Left -or $dx -gt 200) { continue }
    if (-not (Test-InApp $b)) { continue }
    if ($dy + $dx -lt $bestDist) { $best = $b; $bestDist = $dy + $dx }
  }
  return $best
}

# Claude's sidebar shows each session as a button, next to a "More options for <title>" button.
# Returns @{ title; button; label } for each one, in sidebar order.
function Get-SidebarSessions($root) {
  $buttons = $root.FindAll($Scope::Descendants, $ButtonCond)
  $seen = @{}
  $out = New-Object System.Collections.ArrayList
  foreach ($b in $buttons) {
    $n = $b.Current.Name
    if (-not $n -or -not $n.StartsWith('More options for ')) { continue }
    $t = $n.Substring('More options for '.Length)
    if ($seen.ContainsKey($t)) { continue }
    # The session button is a sibling in the same group whose name starts with the title.
    $parent = $Walker.GetParent($b)
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

# Is this one of the sidebar's own buttons? They sit directly in the group named "Sidebar"
# (session rows sit one level deeper, each in its own group with its "More options" button).
function Test-SidebarButton($b) {
  $p = $Walker.GetParent($b)
  return [bool]($p -and $p.Current.ControlType -eq $CT::Group -and $p.Current.Name -eq 'Sidebar' -and (Test-InApp $p))
}

# A sidebar button that can be pressed (Invoke), with exactly this name. $null if none.
function Get-SidebarButton($root, $name) {
  $cond = New-Object System.Windows.Automation.AndCondition($ButtonCond, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)))
  foreach ($b in $root.FindAll($Scope::Descendants, $cond)) {
    $pattern = $null
    if ($b.Current.IsEnabled -and (Test-SidebarButton $b) -and $b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { return $b }
  }
  return $null
}

# Claude's per-folder buttons: "New session in <folder>, added to <group>" (or without the group).
function Get-NewInFolderButtons($root) {
  $out = New-Object System.Collections.ArrayList
  foreach ($b in $root.FindAll($Scope::Descendants, $ButtonCond)) {
    $n = $b.Current.Name
    if (-not $n -or -not $n.StartsWith('New session in ')) { continue }
    $rest = $n.Substring('New session in '.Length)
    $i = $rest.LastIndexOf(', added to ')
    $folder = if ($i -ge 0) { $rest.Substring(0, $i) } else { $rest }
    $group = if ($i -ge 0) { $rest.Substring($i + ', added to '.Length) } else { '' }
    $pattern = $null
    if ($folder -and (Test-SidebarButton $b) -and $b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
      [void]$out.Add(@{ folder = $folder; group = $group; button = $b })
    }
  }
  return $out
}

# A new session that hasn't started yet, on Claude's own page: the page is titled just "Claude",
# it shows a "New session" heading (outside the sidebar and any conversation), a prompt box, and a
# chosen folder. Returns @{ folder } or $null.
function Get-NewSessionPage($root, $title) {
  if ($null -ne $title) { return $null }
  try { if ($script:App.Current.Name -ne 'Claude') { return $null } } catch { return $null }
  if (-not (Get-PromptBox $root)) { return $null }
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Text)),
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'New session')))
  $heading = $null
  foreach ($t in $root.FindAll($Scope::Descendants, $cond)) {
    if ($t.Current.IsOffscreen -or -not (Test-InApp $t)) { continue }
    $inside = $false
    $p = $Walker.GetParent($t)
    for ($i = 0; $p -and $i -lt 12; $i++) {
      if ($p.Current.ControlType -eq $CT::Document) { break }
      $pn = $p.Current.Name
      if ($pn -eq 'Sidebar' -or $pn -eq 'Chat messages') { $inside = $true; break }
      $p = $Walker.GetParent($p)
    }
    if (-not $inside) { $heading = $t; break }
  }
  if (-not $heading) { return $null }
  foreach ($b in $root.FindAll($Scope::Descendants, $ButtonCond)) {
    $n = $b.Current.Name
    if ($n -and $n.StartsWith('Folder: ') -and $n.Length -gt 'Folder: '.Length -and (Test-InApp $b)) { return @{ folder = $n.Substring('Folder: '.Length).Trim() } }
  }
  return $null # no folder chosen yet: not a page a prompt can be sent from
}

try {
  $proc = Find-ClaudeWindow
  if (-not $proc) { Out-Json @{ ok = $false; error = 'claude_window_not_found'; message = 'The Claude desktop app is not open (or is minimized to the tray).' } }
  $script:Win = $AE::FromHandle($proc.MainWindowHandle)
  # Everything below looks only inside Claude's own page.
  $script:App = Find-AppDocument $script:Win
  if (-not $script:App) { Out-Json @{ ok = $false; error = 'claude_page_not_found'; message = "The Claude window is open, but its page isn't showing (still loading?)." } }
  $root = $script:App
  $title = Get-SessionTitle $root

  # ---- info ----
  if ($Mode -eq 'info') {
    $box = Get-PromptBox $root
    $page = Get-NewSessionPage $root $title
    Out-Json @{ ok = $true; sessionTitle = $title; newSession = [bool]$page; folder = $(if ($page) { $page.folder } else { $null }); promptBoxFound = [bool]$box; promptText = $(if ($box) { Get-BoxText $box } else { $null }) }
  }

  # ---- new ----
  if ($Mode -eq 'new') {
    $box = Get-PromptBox $root
    if ($box -and (Get-BoxText $box)) {
      Out-Json @{ ok = $false; error = 'prompt_box_not_empty'; message = "The prompt box has text typed in it, so Orbit stayed in this session (so the draft isn't lost)."; sessionTitle = $title }
    }
    $want = if ($ProjectB64) { (Decode $ProjectB64).Trim() } else { '' }
    $target = $null
    if ($want) {
      # Only Claude's own per-folder "New session in <folder>" buttons, matched by folder or group name.
      $choices = @(Get-NewInFolderButtons $root)
      $names = @($choices | ForEach-Object { $_.folder } | Select-Object -Unique -First 15)
      $hits = @($choices | Where-Object { $_.folder -ieq $want -or $_.group -ieq $want })
      if (-not $hits.Count) { $hits = @($choices | Where-Object { $_.folder.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.group.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
      if (-not $hits.Count) {
        Out-Json @{ ok = $false; error = 'project_not_in_sidebar'; message = "Claude's sidebar has no project folder by that name."; projects = $names; sessionTitle = $title }
      }
      # Only an unambiguous match: never guess between two folders.
      if (@($hits | ForEach-Object { $_.folder } | Select-Object -Unique).Count -gt 1) {
        Out-Json @{ ok = $false; error = 'project_ambiguous'; message = 'More than one project folder matches that name.'; projects = @($hits | ForEach-Object { $_.folder } | Select-Object -Unique -First 15); sessionTitle = $title }
      }
      $button = $hits[0].button
    } else {
      $page = Get-NewSessionPage $root $title
      if ($page) { Out-Json @{ ok = $true; created = $false; newSession = $true; folder = $page.folder; message = 'A new session is already open and empty.' } }
      # Only the sidebar's own top "New" button (other "New session" buttons belong to one section).
      $button = Get-SidebarButton $root 'New'
    }
    if (-not $button) { Out-Json @{ ok = $false; error = 'new_button_not_found'; message = "Couldn't find Claude's New session button. Is the sidebar hidden?"; sessionTitle = $title } }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 100
      $now = Get-SessionTitle $root
      $root = $script:App # re-found if the page was replaced
      $page = Get-NewSessionPage $root $now
      $box = Get-PromptBox $root
      if ($page -and $box -and -not (Get-BoxText $box)) { Out-Json @{ ok = $true; created = $true; newSession = $true; folder = $page.folder } }
    }
    Out-Json @{ ok = $false; error = 'new_session_not_confirmed'; message = "Pressed New session, but Claude didn't show an empty new session."; sessionTitle = (Get-SessionTitle $root) }
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
  if ($ExpectNew) {
    $page = Get-NewSessionPage $root $title
    $wantFolder = if ($ExpectFolderB64) { Decode $ExpectFolderB64 } else { $null }
    if (-not $page -or ($null -ne $wantFolder -and $page.folder -ne $wantFolder)) {
      Out-Json @{ ok = $false; error = 'session_changed'; message = 'The new session this prompt was drafted for is no longer open (or is now in a different folder), so nothing was sent.'; sessionTitle = $title }
    }
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
  # A new session gets its page (and title) once Claude accepts the first message.
  if ($ExpectNew) {
    for ($i = 0; $i -lt 30 -and -not $title; $i++) {
      Start-Sleep -Milliseconds 100
      $title = Get-SessionTitle $root
    }
  }
  Out-Json @{ ok = $true; sent = $true; confirmed = $confirmed; sessionTitle = $title; newSession = [bool]$ExpectNew }
} catch {
  Out-Json @{ ok = $false; error = 'script_exception'; message = "$($_.Exception.Message)" }
}
