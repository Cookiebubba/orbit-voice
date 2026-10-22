# Talks to the Claude desktop app's windows through Windows UI Automation (the accessibility API).
# It never moves the mouse, presses keys or touches the clipboard. The one change of focus is
# one you ask for: switching to a session in another Claude window brings that window to the
# front (see Show-Window).
#
# Claude can have several windows: the main one (with the sidebar, possibly in split view) and
# sessions popped out into windows of their own. The "front" window is the one Orbit acts on and
# reports as the open session: -FrontHwnd (the Claude window Orbit's orb follows, the one most
# recently in front) when it's still a usable Claude window, else the highest Claude window in
# z-order that isn't minimized (the most recently active one).
#
#   -Mode info   : which session is open in the front window, whether its prompt box has text,
#                  and every Claude window with the session it shows
#   -Mode list   : the sessions listed in Claude's sidebar(s), with the window each is open in
#   -Mode switch : open a session by title (-TitleB64): bring forward the window it's already open
#                  in, or click it in the sidebar (of the front window, else of the window whose
#                  sidebar lists it)
#   -Mode new    : press Claude's own "New" button in the sidebar (or "New session in <folder>"
#                  for -ProjectB64) and confirm an empty new-session prompt box appeared.
#                  Nothing is typed or sent; Claude creates the session with its first message.
#   -Mode send   : fill the prompt box (-TextB64) and press Claude's Send button, in the one window
#                  that shows the expected session:
#                  -ExpectTitleB64 refuses unless exactly one window shows that session.
#                  -ExpectNew refuses unless exactly one window shows a new, not yet started
#                  session (in folder -ExpectFolderB64, when given).
#                  The session is checked again just before Send is pressed.
#                  -DryRun fills the box, checks it, then clears it again without sending.
# Everything is looked up only inside Claude's own page, never in a web page shown in its window.
# Always prints one line of JSON.
param(
  [ValidateSet('info', 'list', 'switch', 'new', 'send')][string]$Mode = 'info',
  [string]$TextB64 = '',
  [string]$TitleB64 = '',
  [string]$ExpectTitleB64 = '',
  [string]$ProjectB64 = '',
  [switch]$ExpectNew,
  [string]$ExpectFolderB64 = '',
  [long]$FrontHwnd = 0,
  [switch]$DryRun,
  # send variants: -Fill types the draft into the box and stops (the user reads it there; PrevB64 is
  # Orbit's earlier draft, which may be replaced); -Filled presses Send only if the box still holds
  # exactly the draft; -Clear empties the box only if it still holds exactly the draft.
  [switch]$Fill,
  [switch]$Filled,
  [switch]$Clear,
  [string]$PrevB64 = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 6; exit 0 }
function Decode($b64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }

$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$ButtonCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$DocCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Document)
$SidebarCond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Group)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Sidebar')))
function ButtonNamed($name) { New-Object System.Windows.Automation.AndCondition($ButtonCond, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name))) }

# The window being worked on (see Use-Window). Everything below looks only inside $script:App.
$script:Win = $null
$script:App = $null
$script:Kind = $null # 'main' (Claude's own page, sidebar or not) | 'popout' (a session in a window of its own)

# Claude's top-level windows, highest in z-order first (UI Automation lists the desktop's windows
# in z-order). @{ el; hwnd; name; min; z }
function Get-ClaudeWindows {
  $ids = @(Get-Process -Name 'claude' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $out = New-Object System.Collections.ArrayList
  if (-not $ids.Count) { return , $out }
  [System.Windows.Automation.Condition[]]$conds = @($ids | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, [int]$_) })
  $cond = if ($conds.Count -gt 1) { [System.Windows.Automation.OrCondition]::new($conds) } else { $conds[0] }
  $z = 0
  foreach ($el in $AE::RootElement.FindAll($Scope::Children, $cond)) {
    try {
      $c = $el.Current
      if ($c.ControlType -ne $CT::Window -or -not $c.Name -or $c.NativeWindowHandle -eq 0) { continue }
      $min = $false; $wp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) { $min = $wp.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized }
      [void]$out.Add(@{ el = $el; hwnd = [long]$c.NativeWindowHandle; name = $c.Name; min = $min; z = $z })
      $z++
    } catch { } # closed while we looked
  }
  return , $out
}

# How many steps an element is below its window.
function Get-Depth($el) {
  $p = $el
  for ($i = 0; $p -and $i -lt 60; $i++) {
    if ($p.Current.ControlType -eq $CT::Window) { return $i }
    $p = $Walker.GetParent($p)
  }
  return 99
}

# Is this element inside exactly this document (its nearest document)?
function Test-InDoc($el, $doc) {
  $d = Get-OwnDocument $el
  return [bool]($d -and $doc -and [System.Windows.Automation.Automation]::Compare($d, $doc))
}

# Claude's own page inside a window: @{ doc; kind } or $null. Web pages Claude shows (the Browser
# pane, previews, the Find bar) are separate documents, so nothing on them is ever read as Claude's
# title or pressed.
#  - The main window: the largest document that has Claude's sidebar; with the sidebar hidden, the
#    largest one named like Claude's page ("Claude", "<title> - Claude Code").
#  - A session popped out into its own window: the document named exactly like the window (Claude
#    titles the window after its own page, never after a web page in it), the shallowest one and
#    only one at that depth, showing that session's own header ("<title>, rename session") and
#    the "Open in main window" button.
function Find-AppDocument($win, $winTitle) {
  $best = $null; $bestScore = -1
  $pop = New-Object System.Collections.ArrayList
  foreach ($d in $win.FindAll($Scope::Descendants, $DocCond)) {
    $c = $d.Current
    $r = $c.BoundingRectangle
    $area = if ($r.IsEmpty) { 0 } else { $r.Width * $r.Height }
    $named = $c.Name -eq 'Claude' -or $c.Name -like '* - Claude Code'
    $hasSidebar = [bool]$d.FindFirst($Scope::Descendants, $SidebarCond)
    if ($hasSidebar -or $named) {
      $score = $(if ($hasSidebar) { 1e12 } else { 0 }) + $area
      if ($score -gt $bestScore) { $best = $d; $bestScore = $score }
    } elseif ($winTitle -and $winTitle -ne 'Claude' -and $c.Name -ceq $winTitle) {
      [void]$pop.Add($d)
    }
  }
  if ($best) { return @{ doc = $best; kind = 'main' } }
  if (-not $pop.Count) { return $null }
  $depths = @($pop | ForEach-Object { Get-Depth $_ })
  $top = ($depths | Measure-Object -Minimum).Minimum
  $at = @(for ($i = 0; $i -lt $pop.Count; $i++) { if ($depths[$i] -eq $top) { $pop[$i] } })
  if ($at.Count -ne 1) { return $null } # two pages that look alike: don't guess
  $doc = $at[0]
  $header = @($doc.FindAll($Scope::Descendants, (ButtonNamed "$winTitle, rename session")) | Where-Object { Test-InDoc $_ $doc })
  $back = @($doc.FindAll($Scope::Descendants, (ButtonNamed 'Open in main window')) | Where-Object { Test-InDoc $_ $doc })
  if (-not $header.Count -or -not $back.Count) { return $null }
  return @{ doc = $doc; kind = 'popout' }
}

# Work in this window from here on. $false if its page can't be found.
function Use-Window($w) {
  if (-not $w.ContainsKey('page')) { $w.page = Find-AppDocument $w.el $w.name }
  if (-not $w.page) { return $false }
  $script:Win = $w.el
  $script:App = $w.page.doc
  $script:Kind = $w.page.kind
  return $true
}

# Every Claude window whose page was found, with the session it shows. @{ ...; title; kind; sidebar }
function Get-UsableWindows {
  $usable = New-Object System.Collections.ArrayList
  foreach ($w in (Get-ClaudeWindows)) {
    try {
      if (-not (Use-Window $w)) { continue }
      $w.title = Get-SessionTitle
      $w.kind = $script:Kind
      $w.sidebar = $script:Kind -eq 'main' -and [bool]$script:App.FindFirst($Scope::Descendants, $SidebarCond)
      [void]$usable.Add($w)
    } catch { }
  }
  return , $usable
}

# The window Orbit acts on (see the top of this file).
function Select-Front($wins) {
  if ($FrontHwnd) { foreach ($w in $wins) { if ($w.hwnd -eq $FrontHwnd -and -not $w.min) { return $w } } }
  foreach ($w in $wins) { if (-not $w.min) { return $w } }
  if ($wins.Count) { return $wins[0] }
  return $null
}

function Get-WindowList($wins, $front) {
  return @($wins | Select-Object -First 12 | ForEach-Object { @{ id = $_.hwnd; title = $_.title; kind = $_.kind; front = ($_ -eq $front); minimized = $_.min } })
}

# Bring a Claude window to the front (restoring it if minimized), as clicking it would: Windows
# only lets the program in front hand the foreground on, so this briefly shares input state with
# it (AttachThreadInput) for the hand-over. No keys or mouse. $true once that window is in front.
function Show-Window($w) {
  if (-not ('OrbitRaise' -as [type])) {
    Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class OrbitRaise {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  public static bool InFront(IntPtr h) { return GetForegroundWindow() == h; }
  public static void Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return;
    uint me = GetCurrentThreadId(), fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    try { BringWindowToTop(h); SetForegroundWindow(h); } finally { if (attached) AttachThreadInput(me, fg, false); }
  }
}
'@
  }
  $h = [IntPtr]$w.hwnd
  [OrbitRaise]::Front($h)
  for ($i = 0; $i -lt 10; $i++) {
    if ([OrbitRaise]::InFront($h)) { return $true }
    Start-Sleep -Milliseconds 50
  }
  return $false
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
function Test-InApp($el) { return Test-InDoc $el $script:App }

# The open session's title: from Claude's page title "<title> - Claude Code" in the main window,
# or the page title itself in a popped-out session window; $null if none.
function Get-SessionTitle {
  try { $n = $script:App.Current.Name } catch {
    $p = Find-AppDocument $script:Win $(try { $script:Win.Current.Name } catch { '' })
    $script:App = $(if ($p) { $p.doc } else { $null }); $script:Kind = $(if ($p) { $p.kind } else { $null })
    $n = $(if ($script:App) { $script:App.Current.Name } else { '' })
  }
  if ($n -and $n.EndsWith(' - Claude Code') -and $n.Length -gt ' - Claude Code'.Length) { return $n.Substring(0, $n.Length - ' - Claude Code'.Length) }
  if ($script:Kind -eq 'popout' -and $n -and $n -ne 'Claude') { return $n }
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
# Returns @{ title; button; label } for each one, in sidebar order. Only used on a window that has
# the sidebar (a popped-out window's header has a "More options" button too).
function Get-SidebarSessions($root) {
  $out = New-Object System.Collections.ArrayList
  $buttons = $root.FindAll($Scope::Descendants, $ButtonCond)
  $seen = @{}
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
  foreach ($b in $root.FindAll($Scope::Descendants, (ButtonNamed $name))) {
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
  if (-not (Get-Process -Name 'claude' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })) {
    Out-Json @{ ok = $false; error = 'claude_window_not_found'; message = 'The Claude desktop app is not open (or is minimized to the tray).' }
  }
  $wins = Get-UsableWindows
  if (-not $wins.Count) {
    if (-not (Get-ClaudeWindows).Count) { Out-Json @{ ok = $false; error = 'claude_window_not_found'; message = 'The Claude desktop app is not open (or is minimized to the tray).' } }
    Out-Json @{ ok = $false; error = 'claude_page_not_found'; message = "The Claude window is open, but its page isn't showing (still loading?)." }
  }
  $front = Select-Front $wins
  [void](Use-Window $front)
  $root = $script:App
  $title = $front.title
  $windows = Get-WindowList $wins $front

  # ---- info ----
  if ($Mode -eq 'info') {
    $box = Get-PromptBox $root
    $page = Get-NewSessionPage $root $title
    # Where the prompt box is, with the window's own rect in the same coordinates (for the pixel
    # buddy, which stands on it; Orbit measures it as a fraction of the window, so DPI doesn't matter).
    $rectOf = { param($e) try { $r = $e.Current.BoundingRectangle; if ($r.Width -gt 0 -and $r.Height -gt 0) { @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } } else { $null } } catch { $null } }
    $boxRect = $(if ($box) { & $rectOf $box } else { $null }) # the text field (the box you see has padding around it)
    $winRect = & $rectOf $root
    Out-Json @{ ok = $true; sessionTitle = $title; newSession = [bool]$page; folder = $(if ($page) { $page.folder } else { $null }); promptBoxFound = [bool]$box; promptText = $(if ($box) { Get-BoxText $box } else { $null }); windowId = $front.hwnd; windows = $windows; promptBoxRect = $boxRect; windowRect = $winRect }
  }

  # ---- list ----
  if ($Mode -eq 'list') {
    # Every sidebar (the front window's first), each session once, with the window it's open in.
    $openIn = @{}
    foreach ($w in $wins) { if ($w.title -and -not $openIn.ContainsKey($w.title)) { $openIn[$w.title] = $w.hwnd } }
    $rows = New-Object System.Collections.ArrayList
    $seen = @{}
    foreach ($w in @(@($front) + @($wins | Where-Object { $_ -ne $front }))) {
      if (-not $w.sidebar -or -not (Use-Window $w)) { continue }
      foreach ($s in (Get-SidebarSessions $script:App)) {
        if ($seen.ContainsKey($s.title)) { continue }
        $seen[$s.title] = $true
        $in = $openIn[$s.title]
        [void]$rows.Add(@{ title = $s.title; label = $s.label; open = [bool]$in; front = ($s.title -eq $title); window = $(if ($in) { $in } else { $w.hwnd }) })
      }
    }
    # Sessions open in a window of their own that no sidebar lists (scrolled out, say).
    foreach ($w in $wins) {
      if ($w.title -and -not $seen.ContainsKey($w.title)) { $seen[$w.title] = $true; [void]$rows.Add(@{ title = $w.title; label = $w.title; open = $true; front = ($w -eq $front); window = $w.hwnd }) }
    }
    Out-Json @{ ok = $true; sessionTitle = $title; sessions = @($rows); windowId = $front.hwnd; windows = $windows }
  }

  # ---- switch ----
  if ($Mode -eq 'switch') {
    $want = (Decode $TitleB64).Trim()
    if (-not $want) { Out-Json @{ ok = $false; error = 'empty_title' } }
    if ($title -eq $want) { Out-Json @{ ok = $true; switched = $false; sessionTitle = $title; windowId = $front.hwnd; message = 'That session is already open.' } }
    # Already open in another window: bring that one forward.
    $shown = $wins | Where-Object { $_.title -eq $want } | Select-Object -First 1
    $hit = $null; $hitWin = $null
    if (-not $shown) {
      # Else in a sidebar: the front window's, then the others (highest first). Exact title, else
      # the first title that contains the words.
      $bars = @(@($front) + @($wins | Where-Object { $_ -ne $front })) | Where-Object { $_.sidebar }
      $all = New-Object System.Collections.ArrayList
      foreach ($w in $bars) { if (Use-Window $w) { foreach ($s in (Get-SidebarSessions $script:App)) { [void]$all.Add(@{ s = $s; w = $w }) } } }
      $pick = $all | Where-Object { $_.s.title -eq $want } | Select-Object -First 1
      if (-not $pick) { $pick = $all | Where-Object { $_.s.title.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1 }
      if (-not $pick) {
        # Words from the title of a session open in a window of its own.
        $shown = $wins | Where-Object { $_.title -and $_.title.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
        if (-not $shown) { Out-Json @{ ok = $false; error = 'session_not_in_sidebar'; message = "Couldn't find that session in Claude's sidebar. It may be archived or scrolled out of the list."; sessionTitle = $title } }
      } else {
        $hit = $pick.s; $hitWin = $pick.w
        if ($hit.title -eq $title) { Out-Json @{ ok = $true; switched = $false; sessionTitle = $title; windowId = $front.hwnd; message = 'That session is already open.' } }
        $other = $wins | Where-Object { $_.title -eq $hit.title } | Select-Object -First 1
        if ($other) { $shown = $other; $hit = $null }
      }
    }
    if ($shown) {
      if ($shown -eq $front -or (Show-Window $shown)) { Out-Json @{ ok = $true; switched = $true; broughtForward = $true; sessionTitle = $shown.title; windowId = $shown.hwnd } }
      Out-Json @{ ok = $false; error = 'window_not_raised'; message = "That session is open in another Claude window, but Windows didn't let Orbit bring it to the front. Click that window to use it."; sessionTitle = $title }
    }
    [void](Use-Window $hitWin)
    $hit.button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 100
      $now = Get-SessionTitle
      if ($now -eq $hit.title) {
        if ($hitWin -ne $front -and -not (Show-Window $hitWin)) {
          Out-Json @{ ok = $false; error = 'window_not_raised'; message = "Opened the session in another Claude window, but Windows didn't let Orbit bring that window to the front. Click it to use it."; sessionTitle = $title }
        }
        Out-Json @{ ok = $true; switched = $true; sessionTitle = $now; windowId = $hitWin.hwnd }
      }
    }
    Out-Json @{ ok = $false; error = 'switch_not_confirmed'; message = "Clicked the session in the sidebar, but the window didn't confirm the switch."; sessionTitle = (Get-SessionTitle) }
  }

  # ---- new ----
  if ($Mode -eq 'new') {
    # In the front window if it has the sidebar, else the highest window that has one.
    $target = $(if ($front.sidebar) { $front } else { $wins | Where-Object { $_.sidebar } | Select-Object -First 1 })
    if (-not $target) { Out-Json @{ ok = $false; error = 'new_button_not_found'; message = "Couldn't find Claude's New session button. Is the sidebar hidden?"; sessionTitle = $title } }
    [void](Use-Window $target)
    $root = $script:App
    $ttitle = $target.title
    $box = Get-PromptBox $root
    if ($box -and (Get-BoxText $box)) {
      Out-Json @{ ok = $false; error = 'prompt_box_not_empty'; message = "The prompt box has text typed in it, so Orbit stayed in this session (so the draft isn't lost)."; sessionTitle = $ttitle }
    }
    $want = if ($ProjectB64) { (Decode $ProjectB64).Trim() } else { '' }
    $button = $null
    if ($want) {
      # Only Claude's own per-folder "New session in <folder>" buttons, matched by folder or group name.
      $choices = @(Get-NewInFolderButtons $root)
      $names = @($choices | ForEach-Object { $_.folder } | Select-Object -Unique -First 15)
      $hits = @($choices | Where-Object { $_.folder -ieq $want -or $_.group -ieq $want })
      if (-not $hits.Count) { $hits = @($choices | Where-Object { $_.folder.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.group.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
      if (-not $hits.Count) {
        Out-Json @{ ok = $false; error = 'project_not_in_sidebar'; message = "Claude's sidebar has no project folder by that name."; projects = $names; sessionTitle = $ttitle }
      }
      # Only an unambiguous match: never guess between two folders.
      if (@($hits | ForEach-Object { $_.folder } | Select-Object -Unique).Count -gt 1) {
        Out-Json @{ ok = $false; error = 'project_ambiguous'; message = 'More than one project folder matches that name.'; projects = @($hits | ForEach-Object { $_.folder } | Select-Object -Unique -First 15); sessionTitle = $ttitle }
      }
      $button = $hits[0].button
    } else {
      $page = Get-NewSessionPage $root $ttitle
      if ($page) {
        if ($target -ne $front -and -not (Show-Window $target)) { Out-Json @{ ok = $false; error = 'window_not_raised'; message = "A new session is open in Claude's main window, but Windows didn't let Orbit bring it to the front."; sessionTitle = $title } }
        Out-Json @{ ok = $true; created = $false; newSession = $true; folder = $page.folder; windowId = $target.hwnd; message = 'A new session is already open and empty.' }
      }
      # Only the sidebar's own top "New" button (other "New session" buttons belong to one section).
      $button = Get-SidebarButton $root 'New'
    }
    if (-not $button) { Out-Json @{ ok = $false; error = 'new_button_not_found'; message = "Couldn't find Claude's New session button. Is the sidebar hidden?"; sessionTitle = $ttitle } }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 100
      $now = Get-SessionTitle
      $root = $script:App # re-found if the page was replaced
      $page = Get-NewSessionPage $root $now
      $box = Get-PromptBox $root
      if ($page -and $box -and -not (Get-BoxText $box)) {
        if ($target -ne $front -and -not (Show-Window $target)) { Out-Json @{ ok = $false; error = 'window_not_raised'; message = "Started a new session in Claude's main window, but Windows didn't let Orbit bring it to the front."; sessionTitle = $title } }
        Out-Json @{ ok = $true; created = $true; newSession = $true; folder = $page.folder; windowId = $target.hwnd }
      }
    }
    Out-Json @{ ok = $false; error = 'new_session_not_confirmed'; message = "Pressed New session, but Claude didn't show an empty new session."; sessionTitle = (Get-SessionTitle) }
  }

  # ---- send ----
  # Into the one window showing the session the prompt was drafted for: never a guess between two.
  $target = $front
  if ($ExpectTitleB64) {
    $expect = Decode $ExpectTitleB64
    $targets = @($wins | Where-Object { $_.title -ceq $expect })
    if ($targets.Count -eq 0) { Out-Json @{ ok = $false; error = 'session_changed'; message = 'The session this prompt was drafted for is no longer open in any Claude window, so nothing was sent.'; sessionTitle = $title } }
    if ($targets.Count -gt 1) { Out-Json @{ ok = $false; error = 'session_ambiguous'; message = 'That session is open in more than one Claude window, so nothing was sent. Close one of them and ask again.'; sessionTitle = $title } }
    $target = $targets[0]
  }
  $wantFolder = if ($ExpectFolderB64) { Decode $ExpectFolderB64 } else { $null }
  $newPage = { param($w) if ($w.title -or -not (Use-Window $w)) { return $null }; $p = Get-NewSessionPage $script:App $null; if ($p -and ($null -eq $wantFolder -or $p.folder -eq $wantFolder)) { return $p }; return $null }
  if ($ExpectNew) {
    $targets = @($wins | Where-Object { & $newPage $_ })
    if ($targets.Count -eq 0) { Out-Json @{ ok = $false; error = 'session_changed'; message = 'The new session this prompt was drafted for is no longer open (or is now in a different folder), so nothing was sent.'; sessionTitle = $title } }
    if ($targets.Count -gt 1) { Out-Json @{ ok = $false; error = 'session_ambiguous'; message = 'More than one Claude window shows a new session, so nothing was sent. Close one of them and ask again.'; sessionTitle = $title } }
    $target = $targets[0]
  }
  [void](Use-Window $target)
  $root = $script:App
  $title = $target.title
  $box = Get-PromptBox $root
  if (-not $box) { Out-Json @{ ok = $false; error = 'prompt_box_not_found'; message = 'No prompt box is visible. Open a Code session in the Claude app.'; sessionTitle = $title } }
  $text = Decode $TextB64
  if (-not $text.Trim()) { Out-Json @{ ok = $false; error = 'empty_text' } }
  $vp = $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  # The same text, whatever the line endings or trailing space.
  $same = { param($a, $b) (([string]$a -replace "`r", '').Trim()) -ceq (([string]$b -replace "`r", '').Trim()) }
  $inBox = Get-BoxText $box

  if ($Clear) {
    # Orbit's own draft only: anything the user typed or changed stays.
    if ($inBox -and (& $same $inBox $text)) { $vp.SetValue(''); Out-Json @{ ok = $true; cleared = $true; sessionTitle = $title } }
    Out-Json @{ ok = $true; cleared = $false; sessionTitle = $title }
  }

  if ($Filled) {
    # The draft was typed in when it was made: send it only if it's still exactly that.
    if (-not (& $same $inBox $text)) { Out-Json @{ ok = $false; error = 'prompt_box_changed'; message = "The text in Claude's prompt box isn't the draft any more (it was edited or cleared), so nothing was sent."; sessionTitle = $title } }
  } else {
    $mayReplace = $PrevB64 -and $inBox -and (& $same $inBox (Decode $PrevB64))
    if ($inBox -and -not $mayReplace) { Out-Json @{ ok = $false; error = 'prompt_box_not_empty'; message = 'The prompt box already has text in it, so nothing was typed there (to avoid wiping a draft).'; sessionTitle = $title } }
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
  }

  # The same session still open in this window, right before Send.
  $still = Get-SessionTitle
  $stillOk = $(if ($ExpectTitleB64) { $still -ceq $expect } elseif ($ExpectNew) { -not $still -and [bool](Get-NewSessionPage $script:App $null) } else { $still -eq $title })
  if (-not $stillOk) {
    try { $vp.SetValue('') } catch {}
    Out-Json @{ ok = $false; error = 'session_changed'; message = 'The session changed while the prompt was being typed in, so nothing was sent.'; sessionTitle = $still }
  }

  if ($Fill) { Out-Json @{ ok = $true; filled = $true; sent = $false; sessionTitle = $title; windowId = $target.hwnd } }

  if ($DryRun) {
    $vp.SetValue('')
    Out-Json @{ ok = $true; sent = $false; dryRun = $true; sessionTitle = $title; windowId = $target.hwnd }
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
      $title = Get-SessionTitle
    }
  }
  Out-Json @{ ok = $true; sent = $true; confirmed = $confirmed; sessionTitle = $title; newSession = [bool]$ExpectNew; windowId = $target.hwnd }
} catch {
  Out-Json @{ ok = $false; error = 'script_exception'; message = "$($_.Exception.Message)" }
}
