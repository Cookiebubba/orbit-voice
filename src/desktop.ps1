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
#                  and every Claude window with the session it shows (-Rects: and where its Send
#                  button is)
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
#   -Mode stop   : press Claude's own Stop button (it replaces Send while Claude works) in the front
#                  window (-ExpectTitleB64: only in the one window showing that session), and confirm
#                  it went away. Never "Stop this task" (a background task's own button).
#   -Mode pending: what Claude is waiting on the user for in the front window (-ExpectTitleB64: the
#                  one window showing that session): a tool-permission card or a question card,
#                  with what it asks and its options, and a key (a hash of all that).
#   -Mode answer : answer that card (-KeyB64: only if it is still exactly that one) by pressing one
#                  of its own buttons: -Choice allow_once | allow_session | allow_always | deny, or
#                  for a question -Choice option -Option <n> (then Submit / Next), or -Choice skip.
#   -Mode app    : one of Claude's own controls in the front window, by -Action (see "---- app ----"):
#                  status / folders (read only), sidebar, tab, panel, scroll, load_earlier, model,
#                  permission, rename, archive, delete. Menus are opened with ExpandCollapse and their
#                  items pressed with Invoke, as a click would; nothing is typed but a new title.
# Everything is looked up only inside Claude's own page, never in a web page shown in its window.
# -OnlyPid (Orbit's own tests): look only at that process's windows (a stand-in Claude window,
# test/e2e/FakeClaude.cs --window), never at the real Claude app.
# Always prints one line of JSON.
param(
  [ValidateSet('info', 'list', 'switch', 'new', 'send', 'stop', 'pending', 'answer', 'app')][string]$Mode = 'info',
  # app: one of Claude's own controls (see "---- app ----" below), with -ValueB64 and -TitleB64.
  [ValidateSet('', 'status', 'folders', 'sidebar', 'tab', 'panel', 'scroll', 'load_earlier', 'model', 'permission', 'rename', 'archive', 'delete')][string]$Action = '',
  [string]$ValueB64 = '',
  [long]$OnlyPid = 0,
  [string]$KeyB64 = '',
  [ValidateSet('', 'allow_once', 'allow_session', 'allow_always', 'deny', 'option', 'skip')][string]$Choice = '',
  [int]$Option = 0,
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
  [string]$PrevB64 = '',
  # info: also find where Claude's Send button is (for Orbit's avatar, which stomps it).
  [switch]$Rects
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
  $ids = if ($OnlyPid) { @($OnlyPid) } else { @(Get-Process -Name 'claude' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
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

# While Claude works, its Send button turns into "Stop" (seen on the live app, 2026-10: a button
# named exactly "Stop" on the prompt box's row). The other names are guesses at a rename; "Stop this
# task" (a background task's row) is never one of them.
$StopNames = @('Stop', 'Stop response', 'Stop generating', 'Stop Claude', 'Interrupt')

# Claude's Send button sits on the prompt box's row, at its right end. -AnyState: also while it's
# disabled (an empty box), for where it is rather than to press it. -Names: the Stop button instead.
function Get-SendButton($root, $box, [switch]$AnyState, [string[]]$Names = @('Send')) {
  $boxRect = $box.Current.BoundingRectangle
  $best = $null
  $bestDist = [double]::MaxValue
  foreach ($b in $root.FindAll($Scope::Descendants, $ButtonCond)) {
    $c = $b.Current
    if ($Names -notcontains $c.Name -or (-not $AnyState -and -not $c.IsEnabled)) { continue }
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
  # No folder chosen yet: still a new session (Orbit can pick one for it), but not one a prompt can
  # be sent from until it has a folder (send refuses it).
  return @{ folder = $null }
}

# ---- what Claude is waiting on the user for ----
# A tool-permission card ("Allow Claude to run a command?" with Allow once / Always allow / Deny) or
# a question card (Claude's AskUserQuestion: options, Skip, then Submit, or Next before the last
# question). From the app's own code (read-only, 2026-10): cards carry the class
# "epitaxy-approval-card" (questions also "epitaxy-question-card", their options
# "epitaxy-answer-option", toggle buttons), the command sits in a region named "The command Claude
# wants to run", and a question card is a group named after the question. Chromium reports an
# element's class attribute as its UI Automation ClassName. Matched by class first, then by
# structure (an allow button and a deny button side by side), so a renamed class doesn't hide one.
$Apos = [string][char]0x2019
$AllowOnceNames = @('Allow once', 'Allow', 'Yes', 'Approve', 'Accept', 'Run', 'Continue')
$AllowSessionNames = @('Allow for this session', 'Allow for this chat', 'Allow for this task', 'Yes, for this session', 'Allow all for this website')
$AllowAlwaysNames = @('Always allow', 'Allow always', 'Always allow for this website', "Yes, and don't ask again", "Yes, and don${Apos}t ask again", 'Allow for all scheduled runs')
$DenyNames = @('Deny', "Don't allow", "Don${Apos}t allow", 'Reject', 'Decline', 'No', 'Keep planning', 'Stay in background')
# Names that mark a permission card even when its class is unknown (never a bare Yes / No / Run).
$StrongNames = @('Allow once', 'Allow', 'Always allow', 'Allow always', 'Allow for this session', 'Approve', 'Deny', "Don't allow", "Don${Apos}t allow", 'Reject')
$QuestionActionNames = @('Submit', 'Next', 'Skip')
$CommandRegionNames = @('The command Claude wants to run', "Claude${Apos}s description and the command Claude wants to run", "Claude's description and the command Claude wants to run", 'What Claude is asking to do')
$TextCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Text)
$GroupCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Group)

function Get-ClassName($el) { try { return [string]$el.Current.ClassName } catch { return '' } }
function Test-Class($el, $cls) { return (' ' + (Get-ClassName $el) + ' ').Contains(" $cls ") }
function Clip($s, $n) { $s = ([string]$s -replace '\s+', ' ').Trim(); if ($s.Length -gt $n) { return $s.Substring(0, $n) + '...' }; return $s }
function Get-Parent($el) { try { return $Walker.GetParent($el) } catch { return $null } }
function Same($a, $b) { return [bool]($a -and $b -and [System.Windows.Automation.Automation]::Compare($a, $b)) }
function Get-Key($s) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$s))) -replace '-', '').Substring(0, 16).ToLower()
}

# How a button answers a permission card: allow_once | allow_session | allow_always | deny | $null.
function Get-AnswerKind($name) {
  $n = ([string]$name).Trim()
  if (-not $n) { return $null }
  if ($AllowAlwaysNames -contains $n -or $n -like 'Always allow*' -or $n -like 'Accept and *') { return 'allow_always' }
  if ($AllowSessionNames -contains $n -or $n -like 'Allow for *') { return 'allow_session' }
  if ($AllowOnceNames -contains $n) { return 'allow_once' }
  if ($DenyNames -contains $n -or $n -like 'Deny*' -or $n -like 'No, *') { return 'deny' }
  return $null
}

# Text inside an element, in order, leaving out button labels (those are its options).
function Get-Texts($el, $max = 12) {
  $skip = @{}
  foreach ($b in $el.FindAll($Scope::Descendants, $ButtonCond)) { $skip[[string]$b.Current.Name] = $true }
  $out = New-Object System.Collections.ArrayList
  foreach ($t in $el.FindAll($Scope::Descendants, $TextCond)) {
    $n = Clip $t.Current.Name 400
    if ($n -and -not $skip.ContainsKey($n)) { [void]$out.Add($n) }
    if ($out.Count -ge $max) { break }
  }
  return , $out
}
function Test-Toggle($b) { $p = $null; return $b.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p) }
function Test-Pressed($b) {
  $p = $null
  if ($b.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { return $p.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On }
  return $false
}
# Press a button: Invoke, or Toggle for a toggle button that can't be invoked. $true if pressed.
function Press($b) {
  $p = $null
  if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return $true }
  if ($b.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return $true }
  return $false
}

# The cards on Claude's page that wait on the user, in page order.
function Find-Cards($root) {
  $cards = New-Object System.Collections.ArrayList
  foreach ($b in $root.FindAll($Scope::Descendants, $ButtonCond)) {
    $name = [string]$b.Current.Name
    $mine = Get-AnswerKind $name
    if (-not ($mine -or ($QuestionActionNames -contains $name) -or (Test-Class $b 'epitaxy-answer-option'))) { continue }
    $card = $null
    $p = Get-Parent $b
    for ($i = 0; $p -and $i -lt 14; $i++) {
      if ($p.Current.ControlType -eq $CT::Document) { break }
      if (Test-Class $p 'epitaxy-approval-card') { $card = $p; break }
      $p = Get-Parent $p
    }
    if (-not $card -and $StrongNames -contains $name) {
      # By structure: the nearest container holding this button and one that answers the other way.
      $p = Get-Parent $b
      for ($i = 0; $p -and $i -lt 4 -and -not $card; $i++) {
        if ($p.Current.ControlType -eq $CT::Document) { break }
        foreach ($o in $p.FindAll($Scope::Descendants, $ButtonCond)) {
          $on = [string]$o.Current.Name
          if ($StrongNames -contains $on -and (((Get-AnswerKind $on) -eq 'deny') -ne ($mine -eq 'deny'))) { $card = $p; break }
        }
        if (-not $card) { $p = Get-Parent $p }
      }
      # That is the row of buttons. The card around it is the nearest container above it (up to
      # three levels) with text of its own (the request, the command) and no other answer buttons.
      if ($card -and -not (Get-Texts $card 1).Count) {
        $count = @($card.FindAll($Scope::Descendants, $ButtonCond) | Where-Object { Get-AnswerKind $_.Current.Name }).Count
        $up = Get-Parent $card
        for ($i = 0; $up -and $i -lt 3; $i++) {
          if ($up.Current.ControlType -eq $CT::Document) { break }
          if (@($up.FindAll($Scope::Descendants, $ButtonCond) | Where-Object { Get-AnswerKind $_.Current.Name }).Count -ne $count) { break }
          if ((Get-Texts $up 1).Count) { $card = $up; break }
          $up = Get-Parent $up
        }
      }
    }
    if (-not $card -and ($QuestionActionNames -contains $name)) {
      # A question by structure: the nearest container above Skip / Submit / Next holding two or
      # more toggle buttons (its options).
      $p = Get-Parent $b
      for ($i = 0; $p -and $i -lt 5 -and -not $card; $i++) {
        if ($p.Current.ControlType -eq $CT::Document) { break }
        $toggles = @($p.FindAll($Scope::Descendants, $ButtonCond) | Where-Object { $_.Current.Name -ne 'Other' -and (Test-Toggle $_) })
        if ($toggles.Count -ge 2) { $card = $p } else { $p = Get-Parent $p }
      }
    }
    if (-not $card -or (Test-SidebarButton $b) -or -not (Test-InApp $card)) { continue }
    $dup = $false
    foreach ($x in $cards) { if (Same $x $card) { $dup = $true; break } }
    if (-not $dup) { [void]$cards.Add($card) }
  }
  return , $cards
}

# A card as Orbit reports it. Permission: { kind, title, detail, options [{ id, label }], key }.
# Question: { kind, question, choices [{ n, label, description, selected }], multiSelect, page, canSkip, key }.
function Read-Card($card) {
  $buttons = @($card.FindAll($Scope::Descendants, $ButtonCond))
  $isQ = Test-Class $card 'epitaxy-question-card'
  $opts = @($buttons | Where-Object { Test-Class $_ 'epitaxy-answer-option' })
  if (-not $opts.Count) {
    # A question card whose classes changed: toggle buttons above a Skip / Submit / Next row.
    $names = @($buttons | ForEach-Object { [string]$_.Current.Name })
    $toggles = @($buttons | Where-Object { $_.Current.Name -ne 'Other' -and (Test-Toggle $_) })
    if ($toggles.Count -ge 2 -and ($names -contains 'Skip' -or $names -contains 'Submit' -or $names -contains 'Next')) { $isQ = $true; $opts = $toggles }
  }
  if ($isQ -or $opts.Count) {
    $q = Clip $card.Current.Name 400
    $texts = Get-Texts $card 40
    if (-not $q -and $texts.Count) { $q = $texts[0] }
    $page = @($texts | Where-Object { $_ -match '^\d+ of \d+$' } | Select-Object -First 1)
    $choices = New-Object System.Collections.ArrayList
    $n = 0
    foreach ($o in $opts) {
      $n++
      $t = Get-Texts $o 3
      $label = $(if ($t.Count) { $t[0] } else { Clip $o.Current.Name 200 })
      $desc = $(if ($t.Count -gt 1) { $t[1] } else { '' })
      [void]$choices.Add(@{ n = $n; label = $label; description = $desc; selected = (Test-Pressed $o) })
    }
    $radio = $false
    foreach ($x in $card.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if (Test-Class $x 'epitaxy-radio-mark') { $radio = $true; break } }
    $acts = @($buttons | Where-Object { $QuestionActionNames -contains $_.Current.Name } | ForEach-Object { [string]$_.Current.Name })
    $p = $(if ($page.Count) { $page[0] } else { '' })
    $sig = "question|$q|$p|" + (($choices | ForEach-Object { $_.label }) -join '|')
    # Single choice shows a radio mark by each option (class epitaxy-radio-mark); several, a checkbox.
    $multi = $choices.Count -gt 0 -and -not $radio -and [bool](@($opts | Where-Object { Test-Class $_ 'epitaxy-answer-option' }).Count)
    return @{ kind = 'question'; question = $q; choices = @($choices); multiSelect = $multi; page = $(if ($p) { $p } else { $null }); canSkip = ($acts -contains 'Skip'); key = (Get-Key $sig) }
  }
  $options = New-Object System.Collections.ArrayList
  foreach ($b in $buttons) {
    $k = Get-AnswerKind $b.Current.Name
    if ($k -and $b.Current.IsEnabled) { [void]$options.Add(@{ id = $k; label = (Clip $b.Current.Name 80) }) }
  }
  $detail = ''
  foreach ($g in $card.FindAll($Scope::Descendants, $GroupCond)) {
    if ($CommandRegionNames -contains [string]$g.Current.Name) { $detail = Clip ((Get-Texts $g 20) -join ' ') 600; break }
  }
  $texts = @((Get-Texts $card 20) | Where-Object { $_ -and -not ($detail -and $detail.Contains($_)) })
  $title = Clip (($texts | Select-Object -First 3) -join ' ') 300
  if (-not $detail -and $texts.Count -gt 3) { $detail = Clip (($texts | Select-Object -Skip 3) -join ' ') 600 }
  $sig = "permission|$title|$detail|" + (($options | ForEach-Object { $_.label }) -join '|')
  return @{ kind = 'permission'; title = $title; detail = $detail; options = @($options); key = (Get-Key $sig) }
}

# The card waiting now (the last one on the page: the newest), read, with its element: @{ card; info } or $null.
function Get-Pending($root) {
  $cards = Find-Cards $root
  if (-not $cards.Count) { return $null }
  $c = $cards[$cards.Count - 1]
  return @{ card = $c; info = (Read-Card $c); count = $cards.Count }
}
function Find-CardByKey($root, $key) {
  foreach ($c in (Find-Cards $root)) { $i = Read-Card $c; if ($i.key -eq $key) { return @{ card = $c; info = $i } } }
  return $null
}

try {
  if ($OnlyPid) {
    # Tests only: a stand-in window. Never a process named like Claude (the real app is claude.exe).
    $p = Get-Process -Id $OnlyPid -ErrorAction SilentlyContinue
    if (-not $p -or $p.ProcessName -ieq 'claude') { Out-Json @{ ok = $false; error = 'test_window_refused'; message = 'OnlyPid must be a running stand-in window, never Claude itself.' } }
  } elseif (-not (Get-Process -Name 'claude' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })) {
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
    # -Rects: Claude's Send button too (Qubit stomps it). Only rects; never pressed here.
    $sendRect = $null
    if ($Rects -and $box) { $sb = Get-SendButton $root $box -AnyState; if ($sb) { $sendRect = & $rectOf $sb } }
    # Claude is working in this session: its Stop button is showing.
    $working = $(if ($box) { [bool](Get-SendButton $root $box -Names $StopNames) } else { $false })
    Out-Json @{ ok = $true; sessionTitle = $title; newSession = [bool]$page; folder = $(if ($page) { $page.folder } else { $null }); promptBoxFound = [bool]$box; promptText = $(if ($box) { Get-BoxText $box } else { $null }); windowId = $front.hwnd; windows = $windows; promptBoxRect = $boxRect; windowRect = $winRect; sendButtonRect = $sendRect; claudeWorking = $working }
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

  # ---- pending / answer ----
  if ($Mode -eq 'pending' -or $Mode -eq 'answer') {
    # The front window, or the one window showing the expected session.
    $target = $front
    if ($ExpectTitleB64) {
      $expect = Decode $ExpectTitleB64
      $targets = @($wins | Where-Object { $_.title -ceq $expect })
      if ($targets.Count -ne 1) { Out-Json @{ ok = $false; error = $(if ($targets.Count) { 'session_ambiguous' } else { 'session_not_open' }); message = $(if ($targets.Count) { 'That session is open in more than one Claude window.' } else { 'That session is not open in a Claude window.' }); sessionTitle = $title } }
      $target = $targets[0]
    }
    [void](Use-Window $target)
    $root = $script:App
    $title = $target.title
    if ($Mode -eq 'pending') {
      $p = Get-Pending $root
      Out-Json @{ ok = $true; sessionTitle = $title; windowId = $target.hwnd; pending = $(if ($p) { $p.info } else { $null }); count = $(if ($p) { $p.count } else { 0 }) }
    }
    # answer: only the card that was read (same key), only with one of its own buttons.
    $key = $(if ($KeyB64) { Decode $KeyB64 } else { '' })
    $hit = $(if ($key) { Find-CardByKey $root $key } else { $null })
    if (-not $hit) {
      $now = Get-Pending $root
      Out-Json @{ ok = $false; error = $(if ($now) { 'prompt_changed' } else { 'nothing_pending' }); message = $(if ($now) { "What Claude is asking changed since it was read, so nothing was pressed." } else { "Claude isn't waiting on anything in this session now." }); pending = $(if ($now) { $now.info } else { $null }); sessionTitle = $title }
    }
    $card = $hit.card
    $info = $hit.info
    $pressed = ''
    if ($info.kind -eq 'permission') {
      if (@('allow_once', 'allow_session', 'allow_always', 'deny') -notcontains $Choice) { Out-Json @{ ok = $false; error = 'bad_choice'; message = 'This is a permission request: allow or deny it.'; sessionTitle = $title } }
      $btn = $null
      foreach ($b in $card.FindAll($Scope::Descendants, $ButtonCond)) { if ($b.Current.IsEnabled -and (Get-AnswerKind $b.Current.Name) -eq $Choice) { $btn = $b; break } }
      if (-not $btn) { Out-Json @{ ok = $false; error = 'choice_not_offered'; message = 'Claude does not offer that answer here.'; options = $info.options; sessionTitle = $title } }
      $pressed = [string]$btn.Current.Name
      if (-not (Press $btn)) { Out-Json @{ ok = $false; error = 'not_pressable'; message = "That button can't be pressed from here."; sessionTitle = $title } }
    } else {
      if ($Choice -eq 'skip') {
        $btn = @($card.FindAll($Scope::Descendants, (ButtonNamed 'Skip')))[0]
        if (-not $btn) { Out-Json @{ ok = $false; error = 'choice_not_offered'; message = 'This question has no Skip.'; sessionTitle = $title } }
        $pressed = 'Skip'
        [void](Press $btn)
      } elseif ($Choice -eq 'option') {
        if ($Option -lt 1 -or $Option -gt $info.choices.Count) { Out-Json @{ ok = $false; error = 'bad_option'; message = "There's no option $Option."; choices = $info.choices; sessionTitle = $title } }
        $opts = @($card.FindAll($Scope::Descendants, $ButtonCond) | Where-Object { Test-Class $_ 'epitaxy-answer-option' })
        if (-not $opts.Count) { $opts = @($card.FindAll($Scope::Descendants, $ButtonCond) | Where-Object { $_.Current.Name -ne 'Other' -and (Test-Toggle $_) }) }
        $o = $opts[$Option - 1]
        $pressed = $info.choices[$Option - 1].label
        if (-not (Test-Pressed $o)) { [void](Press $o) }
        # Then Submit (Next before the last question), once it's enabled; the card may be redrawn.
        $sent = $false
        for ($i = 0; $i -lt 20 -and -not $sent; $i++) {
          $again = Find-CardByKey $root $key
          if (-not $again) { break }
          foreach ($b in $again.card.FindAll($Scope::Descendants, $ButtonCond)) {
            if (@('Submit', 'Next') -contains $b.Current.Name -and $b.Current.IsEnabled) { [void](Press $b); $sent = $true; break }
          }
          if (-not $sent) { Start-Sleep -Milliseconds 100 }
        }
        if (-not $sent) { Out-Json @{ ok = $false; error = 'submit_not_found'; message = "Picked the option, but couldn't press Submit."; sessionTitle = $title } }
      } else {
        Out-Json @{ ok = $false; error = 'bad_choice'; message = 'This is a question: pick an option, or skip it.'; choices = $info.choices; sessionTitle = $title }
      }
    }
    # Claude takes the card away (or shows the next question) once it has the answer.
    $gone = $false
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 100
      if (-not (Find-CardByKey $root $key)) { $gone = $true; break }
    }
    $next = Get-Pending $root
    Out-Json @{ ok = $true; answered = $true; pressed = $pressed; confirmed = $gone; sessionTitle = $title; next = $(if ($next) { $next.info } else { $null }) }
  }

  # ---- stop ----
  if ($Mode -eq 'stop') {
    # The front window, or the one window showing the expected session.
    $target = $front
    if ($ExpectTitleB64) {
      $expect = Decode $ExpectTitleB64
      $targets = @($wins | Where-Object { $_.title -ceq $expect })
      if ($targets.Count -ne 1) { Out-Json @{ ok = $false; error = $(if ($targets.Count) { 'session_ambiguous' } else { 'session_changed' }); message = 'That session is not open in exactly one Claude window, so nothing was stopped.'; sessionTitle = $title } }
      $target = $targets[0]
    }
    [void](Use-Window $target)
    $root = $script:App
    $title = $target.title
    $box = Get-PromptBox $root
    if (-not $box) { Out-Json @{ ok = $false; error = 'prompt_box_not_found'; message = 'No prompt box is visible, so there is no Stop button to press.'; sessionTitle = $title } }
    $stop = Get-SendButton $root $box -Names $StopNames
    if (-not $stop) { Out-Json @{ ok = $false; error = 'not_working'; message = "Claude isn't working in this session (there's no Stop button), so there was nothing to stop."; sessionTitle = $title } }
    $pattern = $null
    if (-not $stop.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { Out-Json @{ ok = $false; error = 'stop_not_pressable'; message = "Claude's Stop button can't be pressed from here."; sessionTitle = $title } }
    $pattern.Invoke()
    # Claude swaps Stop back to Send once the run has ended.
    $confirmed = $false
    for ($i = 0; $i -lt 25; $i++) {
      Start-Sleep -Milliseconds 100
      if (-not (Get-SendButton $root $box -Names $StopNames)) { $confirmed = $true; break }
    }
    Out-Json @{ ok = $true; stopped = $true; confirmed = $confirmed; sessionTitle = $title; windowId = $target.hwnd }
  }

  # ---- app ----
  # Claude's own controls, found by the names UI Automation shows of the real window (read-only,
  # 2026-10): "Hide sidebar" / "Show sidebar"; the "Mode" switch (radio buttons "Claude" and
  # "Code"); the session header's "<title>, rename session" and "More options for <title>"; the
  # panel toggles "Terminal", "Changes", "Browser", "Files"; on the composer row "Add", the
  # permission mode ("Bypass permissions", ...) and "Model: <model> <effort>", each opening a menu
  # (ExpandCollapse); the conversation's scroll container and its "Load earlier messages". What
  # is inside those menus, the rename field and the delete confirmation was not opened on the
  # real app (that would mean clicking it): it's matched loosely, and every action checks its
  # result instead of assuming it.
  if ($Mode -eq 'app') {
    $value = $(if ($ValueB64) { (Decode $ValueB64).Trim() } else { '' })
    $all = { param($ct) @($root.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $ct))) | Where-Object { Test-InApp $_ }) }
    $named = { param($ct, $name) @(& $all $ct | Where-Object { $_.Current.Name -eq $name }) | Select-Object -First 1 }
    $pat = { param($el, $p) $x = $null; if ($el -and $el.TryGetCurrentPattern($p::Pattern, [ref]$x)) { $x } else { $null } }
    $EC = [System.Windows.Automation.ExpandCollapsePattern]
    $IP = [System.Windows.Automation.InvokePattern]
    $TP = [System.Windows.Automation.TogglePattern]
    $SIP = [System.Windows.Automation.SelectionItemPattern]
    $SP = [System.Windows.Automation.ScrollPattern]
    $VP = [System.Windows.Automation.ValuePattern]
    # Open a menu button (ExpandCollapse; Invoke if that's all it has).
    $expand = { param($b) $e = & $pat $b $EC; if ($e) { $e.Expand(); return $true }; $i = & $pat $b $IP; if ($i) { $i.Invoke(); return $true }; return $false }
    $collapse = { param($b) try { $e = & $pat $b $EC; if ($e) { $e.Collapse() } } catch { } }
    # The items of the menu that just opened: menu items (or list items / radio buttons in a popup).
    $menuItems = {
      for ($i = 0; $i -lt 15; $i++) {
        $items = @(& $all $CT::MenuItem | Where-Object { $_.Current.IsEnabled -and $_.Current.Name })
        if ($items.Count) { return $items } # (one by one: callers pipe them, or collect them with @())
        Start-Sleep -Milliseconds 100
      }
    }
    $press = { param($el) $i = & $pat $el $IP; if ($i) { $i.Invoke(); return $true }; $s = & $pat $el $SIP; if ($s) { $s.Select(); return $true }; $t = & $pat $el $TP; if ($t) { $t.Toggle(); return $true }; return $false }
    $box = Get-PromptBox $root
    $buttons = & $all $CT::Button
    $modelBtn = $buttons | Where-Object { $_.Current.Name -like 'Model: *' } | Select-Object -First 1
    $PermLike = '^(ask( before edits| permissions)?|accept edits|edit automatically|auto( mode|-accept edits)?|plan mode|bypass permissions|default)$'
    $permBtn = $buttons | Where-Object { $_.Current.Name -match $PermLike -and (& $pat $_ $EC) } | Select-Object -First 1
    $sideBtn = $buttons | Where-Object { $_.Current.Name -eq 'Hide sidebar' -or $_.Current.Name -eq 'Show sidebar' } | Select-Object -First 1
    $modeGrp = & $all $CT::Group | Where-Object { $_.Current.Name -eq 'Mode' } | Select-Object -First 1
    $tabNow = $null
    if ($modeGrp) { foreach ($r in $modeGrp.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::RadioButton)))) { $s = & $pat $r $SIP; if ($s -and $s.Current.IsSelected) { $tabNow = $(if ($r.Current.Name -eq 'Code') { 'code' } else { 'chat' }) } } }
    $PANELS = @{ terminal = 'Terminal'; changes = 'Changes'; browser = 'Browser'; files = 'Files'; rail = 'Hide session rail' }
    $panelState = @{}
    foreach ($k in $PANELS.Keys) { $b = $buttons | Where-Object { $_.Current.Name -eq $PANELS[$k] } | Select-Object -First 1; $t = & $pat $b $TP; if ($t) { $panelState[$k] = $t.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On } }
    $page = Get-NewSessionPage $root $title
    # The conversation's scroll container: the largest scrollable area outside the sidebar.
    $scroller = $null; $best = 0
    foreach ($e in $root.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::IsScrollPatternAvailableProperty, $true)))) {
      if ($e.Current.ControlType -eq $CT::Document -or -not (Test-InApp $e)) { continue }
      $s = & $pat $e $SP
      if (-not $s -or -not $s.Current.VerticallyScrollable) { continue }
      $r = $e.Current.BoundingRectangle; $a = $(if ($r.IsEmpty) { 0 } else { $r.Width * $r.Height })
      if ($a -gt $best) { $scroller = $e; $best = $a }
    }
    $status = {
      @{ ok = $true; sessionTitle = $title; windowId = $front.hwnd; sidebar = $(if ($sideBtn) { $sideBtn.Current.Name -eq 'Hide sidebar' } else { $null }); tab = $tabNow; model = $(if ($modelBtn) { $modelBtn.Current.Name.Substring(7) } else { $null }); permission = $(if ($permBtn) { $permBtn.Current.Name } else { $null }); panels = $panelState; newSession = [bool]$page; folder = $(if ($page) { $page.folder } else { $null }); canScroll = [bool]$scroller; canLoadEarlier = [bool]($buttons | Where-Object { $_.Current.Name -eq 'Load earlier messages' } | Select-Object -First 1) }
    }
    switch ($Action) {
      'status' { Out-Json (& $status) }
      'folders' {
        $f = @(Get-NewInFolderButtons $root | ForEach-Object { @{ folder = $_.folder; group = $_.group } } | Select-Object -First 30)
        Out-Json @{ ok = $true; folders = $f; newSession = [bool]$page; folder = $(if ($page) { $page.folder } else { $null }); sessionTitle = $title }
      }
      'sidebar' {
        if (-not $sideBtn) { Out-Json @{ ok = $false; error = 'control_not_found'; message = "Couldn't find Claude's sidebar button." } }
        $shown = $sideBtn.Current.Name -eq 'Hide sidebar'
        $want = $(if ($value -eq 'show') { $true } elseif ($value -eq 'hide') { $false } else { -not $shown })
        if ($want -ne $shown) { [void](& $press $sideBtn) }
        $ok = $false
        for ($i = 0; $i -lt 15 -and -not $ok; $i++) { Start-Sleep -Milliseconds 100; $ok = [bool](& $all $CT::Button | Where-Object { $_.Current.Name -eq $(if ($want) { 'Hide sidebar' } else { 'Show sidebar' }) }) }
        Out-Json @{ ok = $ok; sidebar = $want; changed = ($want -ne $shown); error = $(if ($ok) { $null } else { 'not_confirmed' }); sessionTitle = $title }
      }
      'tab' {
        $want = $(if ($value -eq 'chat') { 'Claude' } else { 'Code' })
        $r = $(if ($modeGrp) { @($modeGrp.FindAll($Scope::Descendants, (ButtonNamed $want))) + @($modeGrp.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.AndCondition((New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::RadioButton)), (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $want)))))) | Select-Object -First 1 } else { $null })
        if (-not $r) { Out-Json @{ ok = $false; error = 'control_not_found'; message = "Couldn't find Claude's Code / chat switch." } }
        $s = & $pat $r $SIP
        if ($s -and $s.Current.IsSelected) { Out-Json @{ ok = $true; tab = $value; changed = $false; sessionTitle = $title } }
        [void](& $press $r)
        $ok = $false
        # (Looked up again each time: the page may redraw the switch.)
        for ($i = 0; $i -lt 15 -and -not $ok; $i++) {
          Start-Sleep -Milliseconds 100
          $r2 = & $all $CT::RadioButton | Where-Object { $_.Current.Name -eq $want } | Select-Object -First 1
          $s2 = & $pat $r2 $SIP
          $ok = [bool]($s2 -and $s2.Current.IsSelected)
        }
        Out-Json @{ ok = $ok; tab = $value; changed = $true; error = $(if ($ok) { $null } else { 'not_confirmed' }) }
      }
      'panel' {
        $parts = $value -split ':'
        $name = $PANELS[$parts[0]]
        $b = $(if ($name) { $buttons | Where-Object { $_.Current.Name -eq $name } | Select-Object -First 1 } else { $null })
        $t = & $pat $b $TP
        if (-not $t) { Out-Json @{ ok = $false; error = 'control_not_found'; message = "Couldn't find that panel's button." } }
        $on = $t.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On
        $want = $(if ($parts[1] -eq 'on') { $true } elseif ($parts[1] -eq 'off') { $false } else { -not $on })
        if ($want -ne $on) { $t.Toggle() }
        Start-Sleep -Milliseconds 150
        $now = $t.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On
        Out-Json @{ ok = ($now -eq $want); panel = $parts[0]; on = $now; changed = ($want -ne $on); sessionTitle = $title }
      }
      'scroll' {
        if (-not $scroller) { Out-Json @{ ok = $false; error = 'control_not_found'; message = "Couldn't find the conversation to scroll." } }
        $s = & $pat $scroller $SP
        $before = $s.Current.VerticalScrollPercent
        $SA = [System.Windows.Automation.ScrollAmount]
        switch ($value) {
          'top' { $s.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, 0) }
          'bottom' { $s.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, 100) }
          'down' { if ($before -lt 100) { $s.Scroll($SA::NoAmount, $SA::LargeIncrement) } }
          default { if ($before -gt 0) { $s.Scroll($SA::NoAmount, $SA::LargeDecrement) } }
        }
        Start-Sleep -Milliseconds 150
        $after = $s.Current.VerticalScrollPercent
        Out-Json @{ ok = $true; before = [math]::Round($before, 1); after = [math]::Round($after, 1); atTop = $after -le 0; atBottom = $after -ge 100; sessionTitle = $title }
      }
      'load_earlier' {
        $b = $buttons | Where-Object { $_.Current.Name -eq 'Load earlier messages' } | Select-Object -First 1
        if (-not $b) { Out-Json @{ ok = $false; error = 'nothing_earlier'; message = 'There are no earlier messages to load.' } }
        Out-Json @{ ok = [bool](& $press $b); sessionTitle = $title }
      }
      { $_ -eq 'model' -or $_ -eq 'permission' } {
        $btn = $(if ($Action -eq 'model') { $modelBtn } else { $permBtn })
        if (-not $btn) { Out-Json @{ ok = $false; error = 'control_not_found'; message = $(if ($Action -eq 'model') { "Couldn't find Claude's model picker." } else { "Couldn't find Claude's permission mode button." }) } }
        $was = [string]$btn.Current.Name
        $match = $(if ($Action -eq 'model') { { param($n) $n.IndexOf($value, [StringComparison]::OrdinalIgnoreCase) -ge 0 } } else {
          $rx = @{ ask = '^(ask|default)'; accept_edits = 'accept edits|edit automatically|auto-?accept'; plan = 'plan'; bypass = 'bypass' }[$value]
          if (-not $rx) { Out-Json @{ ok = $false; error = 'bad_value'; message = 'Unknown permission mode.' } }
          { param($n) $n -match $rx }.GetNewClosure() })
        if ($Action -eq 'permission' -and $was -match $rx) { Out-Json @{ ok = $true; changed = $false; permission = $was; sessionTitle = $title } }
        if ($Action -eq 'model' -and $was.IndexOf($value, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Out-Json @{ ok = $true; changed = $false; model = $was.Substring(7); sessionTitle = $title } }
        if (-not (& $expand $btn)) { Out-Json @{ ok = $false; error = 'not_pressable'; message = "That picker can't be opened from here." } }
        $items = @(& $menuItems)
        $names = @($items | ForEach-Object { [string]$_.Current.Name } | Select-Object -First 20)
        $hits = @($items | Where-Object { & $match ([string]$_.Current.Name) })
        # Several alike ("Opus 5.5", "Opus 5.5 (1M context)"): the plainest one.
        if ($hits.Count -gt 1 -and $Action -eq 'model') { $hits = @($hits | Sort-Object { ([string]$_.Current.Name).Length } | Select-Object -First 1) }
        if ($hits.Count -ne 1) {
          & $collapse $btn
          Out-Json @{ ok = $false; error = $(if ($hits.Count) { 'ambiguous' } else { 'not_offered' }); message = $(if ($hits.Count) { 'More than one choice matches that.' } else { "Claude's picker has no choice like that." }); options = $names; sessionTitle = $title }
        }
        $picked = [string]$hits[0].Current.Name
        [void](& $press $hits[0])
        $now = $was
        for ($i = 0; $i -lt 20; $i++) {
          Start-Sleep -Milliseconds 100
          $b2 = $(if ($Action -eq 'model') { & $all $CT::Button | Where-Object { $_.Current.Name -like 'Model: *' } | Select-Object -First 1 } else { & $all $CT::Button | Where-Object { $_.Current.Name -match $PermLike } | Select-Object -First 1 })
          if ($b2) { $now = [string]$b2.Current.Name }
          if ($now -ne $was) { break }
        }
        Out-Json @{ ok = ($now -ne $was); picked = $picked; now = $(if ($Action -eq 'model' -and $now -like 'Model: *') { $now.Substring(7) } else { $now }); error = $(if ($now -ne $was) { $null } else { 'not_confirmed' }); sessionTitle = $title }
      }
      { $_ -eq 'rename' -or $_ -eq 'archive' -or $_ -eq 'delete' } {
        $target = $(if ($TitleB64) { (Decode $TitleB64).Trim() } else { $title })
        if (-not $target) { Out-Json @{ ok = $false; error = 'no_session'; message = 'No session is open to do that to.' } }
        $rowsNow = { @(Get-SidebarSessions $root | ForEach-Object { $_.title }) }
        $more = @($buttons | Where-Object { $_.Current.Name -eq "More options for $target" })
        if ($Action -eq 'rename') {
          if (-not $value) { Out-Json @{ ok = $false; error = 'no_name'; message = 'Say what to call it.' } }
          $hdr = $buttons | Where-Object { $_.Current.Name -eq "$target, rename session" } | Select-Object -First 1
          $opened = $false
          if ($hdr) { $opened = [bool](& $press $hdr) }
          elseif ($more.Count) { if (& $expand $more[0]) { $it = @(& $menuItems | Where-Object { $_.Current.Name -match '^rename' }); if ($it.Count) { $opened = [bool](& $press $it[0]) } else { & $collapse $more[0] } } }
          if (-not $opened) { Out-Json @{ ok = $false; error = 'control_not_found'; message = "Couldn't find how to rename that session." } }
          $edit = $null
          for ($i = 0; $i -lt 15 -and -not $edit; $i++) {
            Start-Sleep -Milliseconds 100
            $edit = & $all $CT::Edit | Where-Object { $_.Current.Name -ne 'Prompt' -and $_.Current.Name -ne 'Find in page' -and ((& $pat $_ $VP).Current.Value -eq $target) } | Select-Object -First 1
          }
          if (-not $edit) { Out-Json @{ ok = $false; error = 'rename_field_not_found'; message = "Opened the rename, but couldn't find its text field." } }
          (& $pat $edit $VP).SetValue($value)
          $save = & $all $CT::Button | Where-Object { @('Save', 'Done', 'Rename', 'Confirm') -contains $_.Current.Name } | Select-Object -First 1
          if ($save) { [void](& $press $save) } elseif ($box) { try { $box.SetFocus() } catch { } }
          $ok = $false
          for ($i = 0; $i -lt 20 -and -not $ok; $i++) { Start-Sleep -Milliseconds 100; $ok = ((& $rowsNow) -contains $value) -or ((Get-SessionTitle) -eq $value) }
          Out-Json @{ ok = $ok; renamed = $ok; from = $target; to = $value; error = $(if ($ok) { $null } else { 'not_confirmed' }); sessionTitle = (Get-SessionTitle) }
        }
        if (-not $more.Count) { Out-Json @{ ok = $false; error = 'session_not_in_sidebar'; message = "Couldn't find that session's options."; sessionTitle = $title } }
        # The sidebar row's own button when it's there (the header's is the open session's).
        $mb = @($more | Where-Object { -not (Test-SidebarButton $_) } | Select-Object -Last 1)
        if (-not $mb.Count) { $mb = @($more[0]) }
        if (-not (& $expand $mb[0])) { Out-Json @{ ok = $false; error = 'not_pressable'; message = "That session's options can't be opened from here." } }
        $want = $(if ($Action -eq 'archive') { '^archive' } else { '^delete' })
        $it = @(& $menuItems | Where-Object { $_.Current.Name -match $want })
        if (-not $it.Count) { & $collapse $mb[0]; Out-Json @{ ok = $false; error = 'not_offered'; message = "Claude doesn't offer that for this session."; sessionTitle = $title } }
        [void](& $press $it[0])
        if ($Action -eq 'delete') {
          # Claude asks first: press its own Delete in the confirmation (never anything else).
          $confirm = $null
          for ($i = 0; $i -lt 15 -and -not $confirm; $i++) { Start-Sleep -Milliseconds 100; $confirm = & $all $CT::Button | Where-Object { $_.Current.Name -eq 'Delete' -and $_.Current.IsEnabled } | Select-Object -First 1 }
          if (-not $confirm) { Out-Json @{ ok = $false; error = 'confirm_not_found'; message = "Claude didn't show its delete confirmation, so nothing was deleted."; sessionTitle = $title } }
          [void](& $press $confirm)
        }
        $gone = $false
        for ($i = 0; $i -lt 20 -and -not $gone; $i++) { Start-Sleep -Milliseconds 100; $gone = -not ((& $rowsNow) -contains $target) }
        Out-Json @{ ok = $gone; done = $Action; session = $target; error = $(if ($gone) { $null } else { 'not_confirmed' }); sessionTitle = (Get-SessionTitle) }
      }
    }
    Out-Json @{ ok = $false; error = 'bad_action'; message = 'Unknown app action.' }
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
  $newPage = { param($w) if ($w.title -or -not (Use-Window $w)) { return $null }; $p = Get-NewSessionPage $script:App $null; if ($p -and $p.folder -and ($null -eq $wantFolder -or $p.folder -eq $wantFolder)) { return $p }; return $null }
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
    if ($mayReplace) {
      # A revision retypes the box: Orbit's earlier draft goes first, so the new one is never added to it.
      $vp.SetValue('')
      Start-Sleep -Milliseconds 60
      if (Get-BoxText $box) { Out-Json @{ ok = $false; error = 'prompt_box_not_cleared'; message = "Couldn't clear the earlier draft from Claude's prompt box, so the new one wasn't typed in (it would have been added to the old one)."; sessionTitle = $title } }
    }
    $vp.SetValue($text)
    Start-Sleep -Milliseconds 250

    $landed = Get-BoxText $box
    $probe = ($text.Trim() -split "`n")[0].Trim()
    if ($probe.Length -gt 30) { $probe = $probe.Substring(0, 30) }
    # It landed, and on its own: not the old draft plus the new one (a box that adds to what it has).
    $alone = (& $same $landed $text) -or ($landed.Length -le $text.Trim().Length + 20)
    if (-not ($landed -and $landed.Contains($probe) -and $alone)) {
      try { $vp.SetValue('') } catch {}
      Out-Json @{ ok = $false; error = 'fill_not_verified'; message = "Couldn't confirm the text reached Claude's prompt box (on its own), so nothing was sent."; sessionTitle = $title }
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
