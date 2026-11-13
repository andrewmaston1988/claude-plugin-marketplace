# Read a control's UIA value from a window. Emits one JSON line.
# Windows PowerShell 5.1:  powershell.exe -NoProfile -File uia-read.ps1 -WindowTitle ui-probe-fixture -ControlName ValueBox
param(
  [string]$WindowTitle = 'ui-probe-fixture',
  [string]$ControlName = 'ValueBox',
  [int]$TimeoutMs = 8000
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$window = $null
$control = $null

while ((Get-Date) -lt $deadline) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $WindowTitle)
  $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if ($window -ne $null) {
    $ccond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $ControlName)
    $control = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $ccond)
    if ($control -ne $null) { break }
  }
  Start-Sleep -Milliseconds 150
}

if ($control -eq $null) {
  @{ found = $false; text = $null; reason = 'control_not_found'; window = $WindowTitle; control = $ControlName } | ConvertTo-Json -Compress
  exit 3
}

$text = $null
try {
  $vp = $control.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $text = $vp.Current.Value
} catch {
  $text = $control.Current.Name
}

@{ found = $true; text = $text; controlType = $control.Current.ControlType.ProgrammaticName } | ConvertTo-Json -Compress
