# WinForms fixture window for the format lane. Known controls, known values.
# Run under Windows PowerShell 5.1:  powershell.exe -STA -File windows-fixture.ps1
param([string]$Value = 'fixture-value-42', [int]$AutoCloseSeconds = 0)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'ui-probe-fixture'
$form.Width = 420
$form.Height = 320
$form.StartPosition = 'CenterScreen'

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Value'
$label.Left = 16; $label.Top = 20; $label.Width = 60
$form.Controls.Add($label)

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'ValueBox'
$box.AccessibleName = 'ValueBox'
$box.Text = $Value
$box.Left = 84; $box.Top = 16; $box.Width = 280
$form.Controls.Add($box)

$check = New-Object System.Windows.Forms.CheckBox
$check.Name = 'FlagBox'
$check.AccessibleName = 'FlagBox'
$check.Text = 'Enabled'
$check.Left = 84; $check.Top = 56
$form.Controls.Add($check)

$button = New-Object System.Windows.Forms.Button
$button.Name = 'ApplyButton'
$button.AccessibleName = 'Apply'
$button.Text = 'Apply'
$button.Left = 84; $button.Top = 88
$form.Controls.Add($button)

$list = New-Object System.Windows.Forms.ListBox
$list.Name = 'ItemsList'
$list.AccessibleName = 'ItemsList'
$list.Left = 84; $list.Top = 124; $list.Width = 280; $list.Height = 90
$list.Items.Add('alpha') | Out-Null
$list.Items.Add('beta') | Out-Null
$form.Controls.Add($list)

if ($AutoCloseSeconds -gt 0) {
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = $AutoCloseSeconds * 1000
  $timer.Add_Tick({ $form.Close() })
  $timer.Start()
}

[System.Windows.Forms.Application]::Run($form)
