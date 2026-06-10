# Windows system tray icon for claude-slack (replacing slack_bridge_tray.pyw)
# Usage: powershell -WindowStyle Hidden -NonInteractive -File windows.ps1 `
#          -PidFile <path> -EntryPath <path> -ConfigPath <path> -NodeExe <path>
param(
  [string]$PidFile,
  [string]$EntryPath,
  [string]$ConfigPath,
  [string]$NodeExe,
  [string]$LogDir = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Text = "claude-slack bridge"
$tray.Visible = $true

# Use a built-in shell icon — no bundled .ico required
$tray.Icon = [System.Drawing.SystemIcons]::Application

$menu = New-Object System.Windows.Forms.ContextMenuStrip

# Status label (non-clickable)
$itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$itemStatus.Text = "Status: checking..."
$itemStatus.Enabled = $false
$menu.Items.Add($itemStatus) | Out-Null

$menu.Items.Add("-") | Out-Null

# Stop bridge
$itemStop = New-Object System.Windows.Forms.ToolStripMenuItem
$itemStop.Text = "Stop bridge"
$itemStop.add_Click({
  # NB: do not name this $pid — that is a read-only automatic variable (this
  # process's own PID); assigning to it fails and Stop-Process would kill the tray.
  $bridgePid = (Get-Content $script:PidFile -ErrorAction SilentlyContinue) -as [int]
  if ($bridgePid) { Stop-Process -Id $bridgePid -Force -ErrorAction SilentlyContinue }
})
$menu.Items.Add($itemStop) | Out-Null

# Restart bridge
$itemRestart = New-Object System.Windows.Forms.ToolStripMenuItem
$itemRestart.Text = "Restart bridge"
$itemRestart.add_Click({
  $bridgePid = (Get-Content $script:PidFile -ErrorAction SilentlyContinue) -as [int]
  if ($bridgePid) { Stop-Process -Id $bridgePid -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
  Start-Process -FilePath $script:NodeExe `
    -ArgumentList $script:EntryPath, "start", "--config", $script:ConfigPath `
    -WindowStyle Hidden
})
$menu.Items.Add($itemRestart) | Out-Null

$menu.Items.Add("-") | Out-Null

# Open log in default text editor
$itemLog = New-Object System.Windows.Forms.ToolStripMenuItem
$itemLog.Text = "Show log"
$itemLog.add_Click({
  $logFile = if ($script:LogDir) {
    Get-ChildItem -Path $script:LogDir -Filter "*.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  } else { $null }
  if ($logFile) {
    Start-Process notepad.exe $logFile
  } else {
    [System.Windows.Forms.MessageBox]::Show("No log file found in: $script:LogDir", "claude-slack")
  }
})
$menu.Items.Add($itemLog) | Out-Null

$menu.Items.Add("-") | Out-Null

# Exit (closes tray only — bridge keeps running)
$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem
$itemExit.Text = "Exit tray"
$itemExit.add_Click({ [System.Windows.Forms.Application]::Exit() })
$menu.Items.Add($itemExit) | Out-Null

$tray.ContextMenuStrip = $menu

# Poll the PID file every 2 s and update the status label + icon
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  $pidStr = Get-Content $script:PidFile -ErrorAction SilentlyContinue
  $alive = $false
  if ($pidStr) {
    $proc = Get-Process -Id ([int]$pidStr) -ErrorAction SilentlyContinue
    $alive = $null -ne $proc
  }
  if ($alive) {
    $script:itemStatus.Text = "Status: running (PID $pidStr)"
    $script:tray.Icon = [System.Drawing.SystemIcons]::Information
    $script:tray.Text = "claude-slack - running"
  } else {
    $script:itemStatus.Text = "Status: stopped"
    $script:tray.Icon = [System.Drawing.SystemIcons]::Warning
    $script:tray.Text = "claude-slack - stopped"
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$timer.Stop()
$tray.Visible = $false
$tray.Dispose()
