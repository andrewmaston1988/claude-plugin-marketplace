# Windows tray icon for the swarm dashboard daemon. Spawned by `swarm serve --daemon`
# (cmd /c start shape — see cmdServe) with every path a named parameter:
#   powershell -WindowStyle Hidden -NonInteractive -File tray.ps1 `
#     -PidFile <dashboard.pid> -NodeExe <node.exe> -ShimPath <~/.swarm/serve.mjs> `
#     -Port <n> -IconPath <dashboard-icon.png> -SwarmHome <~/.swarm>
param(
  [string]$PidFile,
  [string]$NodeExe,
  [string]$ShimPath,
  [int]$Port = 7331,
  [string]$IconPath = "",
  # Not -Home: $HOME is a read-only automatic variable, and binding to it fails the
  # whole script before a line runs.
  [string]$SwarmHome = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

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
$script:tray.Text = 'swarm dashboard'
$script:tray.Visible = $true

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

$script:itemRestart = New-Object System.Windows.Forms.ToolStripMenuItem
$script:itemRestart.Text = 'Restart'
# Through the stable shim, never a baked plugin-cache path — the menu must
# survive every `claude plugin update`. Start-Process keeps the menu
# responsive; the poll shows the new daemon as it comes up.
$script:itemRestart.add_Click({
  Start-Process -FilePath $script:NodeExe -WindowStyle Hidden `
    -ArgumentList @($script:ShimPath, 'scripts/swarm.mjs', 'serve', 'restart')
})
$menu.Items.Add($script:itemRestart) | Out-Null

$script:itemStop = New-Object System.Windows.Forms.ToolStripMenuItem
$script:itemStop.Text = 'Stop'
$script:itemStop.add_Click({
  Start-Process -FilePath $script:NodeExe -WindowStyle Hidden `
    -ArgumentList @($script:ShimPath, 'scripts/swarm.mjs', 'serve', 'stop')
})
$menu.Items.Add($script:itemStop) | Out-Null

$menu.Items.Add('-') | Out-Null

# Exit closes the tray only — the daemon keeps running.
$script:itemExit = New-Object System.Windows.Forms.ToolStripMenuItem
$script:itemExit.Text = 'Exit tray'
$script:itemExit.add_Click({ [System.Windows.Forms.Application]::Exit() })
$menu.Items.Add($script:itemExit) | Out-Null

$script:tray.ContextMenuStrip = $menu

# Poll the pid RECORD (JSON, with a bare-integer fallback for a daemon started
# before the record format) every 2s. A daemon dead for 5 straight polls exits
# the tray: the icon must not linger once nothing can bring the daemon back on
# its own, and 10s comfortably rides out a restart or update handover, after
# which this poll sees the replacement's new pid.
$script:deadStreak = 0
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
    if ($alive) {
      $script:deadStreak = 0
      $script:itemStatus.Text = 'Status: running (PID {0})' -f $daemonPid
      if ($daemonVersion) { $script:itemVersion.Text = 'Version: {0}' -f $daemonVersion }
      else { $script:itemVersion.Text = 'Version: unknown' }
      $script:tray.Text = 'swarm dashboard - running'
    } else {
      $script:deadStreak = $script:deadStreak + 1
      $script:itemStatus.Text = 'Status: stopped'
      $script:tray.Text = 'swarm dashboard - stopped'
      if ($script:deadStreak -ge 5) { [System.Windows.Forms.Application]::Exit() }
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