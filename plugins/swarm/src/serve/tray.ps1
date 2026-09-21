# Windows tray icon for the swarm dashboard daemon. Spawned by `swarm serve --daemon`
# (cmd /c start shape — see cmdServe) with every path a named parameter:
#   powershell -WindowStyle Hidden -NonInteractive -File tray.ps1 `
#     -PidFile <dashboard.pid> -NodeExe <node.exe> -ShimPath <~/.swarm/serve.mjs> `
#     -Port <n> -IconPath <dashboard-icon.png> -SwarmHome <~/.swarm> [-Disabled]
param(
  [string]$PidFile,
  [string]$NodeExe,
  [string]$ShimPath,
  [int]$Port = 7331,
  [string]$IconPath = "",
  # Not -Home: $HOME is a read-only automatic variable, and binding to it fails the
  # whole script before a line runs.
  [string]$SwarmHome = "",
  # dashboard.enabled is false. The tray still starts — it is the only surface left
  # that can turn the dashboard back on — so it starts in its off state.
  [switch]$Disabled
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Get-TrayAction (D4c): the pure decide-what-to-do-next function the 2s poll
# below calls every tick.
. (Join-Path $PSScriptRoot 'tray-decide.ps1')

if (-not $PidFile -or -not $NodeExe -or -not $ShimPath) { exit 1 }

# One tray at a time: a re-exec spawns no new tray (the daemon polls the pid FILE,
# so the same icon follows the new pid), but `serve restart` re-runs the --daemon
# path while this tray is still alive. A live tray process named by the guard
# makes the newcomer exit silently instead of stacking a second icon. Pid reuse
# onto another powershell process is possible but rare; the guard is a heuristic.
$guardPath = if ($SwarmHome) { Join-Path $SwarmHome 'dashboard-tray.pid' } else { '' }
if ($guardPath -and (Test-Path $guardPath -PathType Leaf)) {
  $otherRaw = Get-Content $guardPath -ErrorAction SilentlyContinue
  $otherPid = 0
  if ($otherRaw) { $otherPid = ("$otherRaw".Trim()) -as [int] }
  if ($otherPid -gt 0) {
    $other = Get-Process -Id $otherPid -ErrorAction SilentlyContinue
    if ($null -ne $other -and $other.ProcessName -match 'powershell|pwsh') { exit 0 }
  }
}
if ($guardPath) { Set-Content -Path $guardPath -Value $PID -Encoding Ascii }

$script:tray = New-Object System.Windows.Forms.NotifyIcon
$script:tray.Text = 'swarm'
$script:tray.Visible = $true

# Whether the dashboard is switched off. Seeded from the spawn, flipped by the
# Enable click below; the poll reads it on every tick.
$script:disabled = [bool]$Disabled

# The daemon renders the same mark the web manifest uses; load via MemoryStream
# so no file handle is held — the next daemon start rewrites the PNG.
$iconOk = $false
if ($IconPath -and (Test-Path $IconPath -PathType Leaf)) {
  try {
    $bytes = [System.IO.File]::ReadAllBytes($IconPath)
    $ms = New-Object System.IO.MemoryStream(,$bytes)
    $bmp = New-Object System.Drawing.Bitmap($ms)
    $hicon = $bmp.GetHicon()
    $script:tray.Icon = [System.Drawing.Icon]::FromHandle($hicon)
    $bmp.Dispose()
    $ms.Dispose()
    $iconOk = $true
  } catch { $iconOk = $false }
}
if (-not $iconOk) { $script:tray.Icon = [System.Drawing.SystemIcons]::Application }

$menu = New-Object System.Windows.Forms.ContextMenuStrip

# Status + version lines (non-clickable), repainted by the poll below.
$script:itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$script:itemStatus.Text = 'Status: checking...'
$script:itemStatus.Enabled = $false
$menu.Items.Add($script:itemStatus) | Out-Null

$script:itemVersion = New-Object System.Windows.Forms.ToolStripMenuItem
$script:itemVersion.Text = 'Version: checking...'
$script:itemVersion.Enabled = $false
$menu.Items.Add($script:itemVersion) | Out-Null

$menu.Items.Add('-') | Out-Null

$script:itemOpen = New-Object System.Windows.Forms.ToolStripMenuItem
$script:itemOpen.Text = 'Open dashboard'
$script:itemOpen.add_Click({
  Start-Process -FilePath ('http://localhost:{0}/' -f $script:Port)
})
$menu.Items.Add($script:itemOpen) | Out-Null

# Through the stable shim, never a baked plugin-cache path — the menu must
# survive every `claude plugin update`. Start-Process keeps the menu
# responsive; the poll shows the new daemon as it comes up. Shared by the
# menu's own Restart click and the poll's auto-restart (D4c).
function Start-SwarmDaemonRestart {
  Start-Process -FilePath $script:NodeExe -WindowStyle Hidden `
    -ArgumentList @($script:ShimPath, 'scripts/swarm.mjs', 'serve', 'restart')
}

$script:itemRestart = New-Object System.Windows.Forms.ToolStripMenuItem
$script:itemRestart.Text = 'Restart'
$script:itemRestart.add_Click({ Start-SwarmDaemonRestart })
$menu.Items.Add($script:itemRestart) | Out-Null

# Enable: write the key through the CLI FIRST — one writer, one validation, one
# message if it refuses — then start the daemon. The write is waited on so a
# refused enable is not followed by a start that cannot work.
function Start-SwarmEnable {
  $enable = Start-Process -FilePath $script:NodeExe -WindowStyle Hidden -Wait -PassThru `
    -ArgumentList @($script:ShimPath, 'scripts/swarm.mjs', 'serve', 'enable')
  if ($enable.ExitCode -ne 0) { return }
  Start-Process -FilePath $script:NodeExe -WindowStyle Hidden `
    -ArgumentList @($script:ShimPath, 'scripts/swarm.mjs', 'serve')
  $script:disabled = $false
  Set-TrayDisabledUi
}

# The off state, restated on the existing menu: Open is greyed (there is nothing to
# open), Restart is greyed (nothing to restart), and Stop's slot becomes the way back
# on. Called once at startup and again after the operator enables the dashboard.
function Set-TrayDisabledUi {
  if ($script:disabled) {
    $script:itemOpen.Text = 'Open dashboard (Disabled)'
    $script:itemOpen.Enabled = $false
    $script:itemRestart.Enabled = $false
    $script:itemStop.Text = 'Enable dashboard'
  } else {
    $script:itemOpen.Text = 'Open dashboard'
    $script:itemOpen.Enabled = $true
    $script:itemRestart.Enabled = $true
    $script:itemStop.Text = 'Stop'
  }
}

$script:itemStop = New-Object System.Windows.Forms.ToolStripMenuItem
$script:itemStop.Text = 'Stop'
$script:itemStop.add_Click({
  if ($script:disabled) {
    Start-SwarmEnable
    return
  }
  Start-Process -FilePath $script:NodeExe -WindowStyle Hidden `
    -ArgumentList @($script:ShimPath, 'scripts/swarm.mjs', 'serve', 'stop')
})
$menu.Items.Add($script:itemStop) | Out-Null

Set-TrayDisabledUi

$menu.Items.Add('-') | Out-Null

# Exit closes the tray only — the daemon keeps running.
$script:itemExit = New-Object System.Windows.Forms.ToolStripMenuItem
$script:itemExit.Text = 'Exit tray'
$script:itemExit.add_Click({ [System.Windows.Forms.Application]::Exit() })
$menu.Items.Add($script:itemExit) | Out-Null

$script:tray.ContextMenuStrip = $menu

# Poll the pid RECORD (JSON, with a bare-integer fallback for a daemon started
# before the record format) every 2s, and hand the read to Get-TrayAction
# (D4c): a daemon dead for 5 straight polls (record present, same pid) either
# auto-restarts through the shim (like the menu's own Restart) or, past 3
# restarts in 10 minutes, gives up and reports "crashed" instead of thrashing.
# A record ABSENT for 5 straight polls (a deliberate `serve stop`) still just
# exits the tray — unless the dashboard is switched off, where an absent record is
# the normal state and the tray is the only way back on. $script:lastDeadPid /
# deadStreak / absentStreak /
# restartTimestamps persist across ticks; a pid change mid-streak (the
# daemon's own handover retake landing between polls) is read as healed, not
# as "still dead".
$script:deadStreak = 0
$script:absentStreak = 0
$script:lastDeadPid = 0
$script:restartTimestamps = @()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  try {
    # NB: do not name this $pid — that is a read-only automatic variable.
    $daemonPid = 0
    $daemonVersion = ''
    $lines = Get-Content $script:PidFile -ErrorAction SilentlyContinue
    if ($lines) {
      $raw = ($lines -join ' ').Trim()
      if ($raw -match '^\d+$') {
        $daemonPid = $raw -as [int]
      } else {
        $rec = $raw | ConvertFrom-Json
        if ($null -ne $rec -and $rec.pid) { $daemonPid = [int]$rec.pid }
        if ($null -ne $rec -and $rec.version) { $daemonVersion = [string]$rec.version }
      }
    }
    $alive = $false
    if ($daemonPid -gt 0) {
      $proc = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
      $alive = ($null -ne $proc)
    }

    $prevLastDeadPid = $script:lastDeadPid
    $samePid = $true
    $streakForDecision = 0
    if ($daemonPid -gt 0 -and -not $alive) {
      $samePid = ($daemonPid -eq $prevLastDeadPid)
      if ($samePid) { $script:deadStreak = $script:deadStreak + 1 } else { $script:deadStreak = 1 }
      $script:lastDeadPid = $daemonPid
      $script:absentStreak = 0
      $streakForDecision = $script:deadStreak
    } elseif ($daemonPid -le 0) {
      $samePid = $false
      $script:absentStreak = $script:absentStreak + 1
      $script:deadStreak = 0
      $script:lastDeadPid = 0
      $streakForDecision = $script:absentStreak
    } else {
      $script:deadStreak = 0
      $script:lastDeadPid = 0
      $script:absentStreak = 0
    }

    $recordPidForDecision = $null
    if ($daemonPid -gt 0) { $recordPidForDecision = $daemonPid }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $action = Get-TrayAction -RecordPid $recordPidForDecision -Alive $alive -Streak $streakForDecision `
      -SamePid $samePid -RestartTimestamps @($script:restartTimestamps) -Now $nowMs -Disabled $script:disabled

    if ($action -eq 'disabled') {
      # A daemon started before the switch is still serving — say so, rather than
      # reporting a dashboard that is off while the port is answering.
      if ($alive) { $script:itemStatus.Text = 'Status: disabled - a daemon from before the switch is still serving (PID {0})' -f $daemonPid }
      else { $script:itemStatus.Text = 'Status: Dashboard disabled' }
      $script:tray.Text = 'swarm - disabled'
    } elseif ($alive) {
      $script:itemStatus.Text = 'Status: running (PID {0})' -f $daemonPid
      if ($daemonVersion) { $script:itemVersion.Text = 'Version: {0}' -f $daemonVersion }
      else { $script:itemVersion.Text = 'Version: unknown' }
      $script:tray.Text = 'swarm - running'
    } elseif ($action -eq 'crashed') {
      $script:itemStatus.Text = 'Status: crashed - use Restart'
      $script:tray.Text = 'swarm - crashed'
    } else {
      $script:itemStatus.Text = 'Status: stopped'
      $script:tray.Text = 'swarm - stopped'
    }

    if ($action -eq 'restart') {
      $script:restartTimestamps = @($script:restartTimestamps) + $nowMs
      # Start the count again: the new daemon takes seconds to write its record, and
      # every poll in that gap still sees the dead pid — without this reset each one
      # would fire another restart and trip "crashed" within a few seconds.
      $script:deadStreak = 0
      Start-SwarmDaemonRestart
    } elseif ($action -eq 'exit') {
      [System.Windows.Forms.Application]::Exit()
    }
  } catch { }
})
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $script:tray.Visible = $false
  $script:tray.Dispose()
  if ($guardPath -and (Test-Path $guardPath -PathType Leaf)) {
    $mine = Get-Content $guardPath -ErrorAction SilentlyContinue
    if ($mine -and ("$mine".Trim()) -eq "$PID") { Remove-Item $guardPath -ErrorAction SilentlyContinue }
  }
}