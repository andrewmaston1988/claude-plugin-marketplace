# Pinned Windows fixtures for the ui-probe bake-off (RQ4/RQ5).
# Windows PowerShell 5.1 only: Windows.Media.Ocr (RQ5) does not load under pwsh 7.
#
#   powershell.exe -File windows_fixtures.ps1                 # all three, as child processes
#   powershell.exe -File windows_fixtures.ps1 -Kind WinForms  # one, stays in this process
#
# Each hosted window prints "PID <n>" once it is on screen and writes the PID to -ReadyFile.
# Titles are fixed; the harness finds windows by exact title.
[CmdletBinding()]
param(
    [ValidateSet('All', 'WinForms', 'Wpf', 'OwnerDrawn')]
    [string]$Kind = 'All',
    [string]$ReadyFile,
    [string]$LogFile
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName PresentationFramework

$Titles = @{
    WinForms   = 'ui-probe fixture (WinForms)'
    Wpf        = 'ui-probe fixture (WPF)'
    OwnerDrawn = 'ui-probe fixture (OwnerDrawn)'
}

function Write-Ready([string]$path, [int]$processId) {
    if ($path) {
        Set-Content -LiteralPath $path -Value $processId -Encoding ASCII
    }
    Write-Output "PID $processId"
    [Console]::Out.Flush()
}

function Add-LogLine([string]$path, [string]$line) {
    if ($path) {
        Add-Content -LiteralPath $path -Value ("{0} {1}" -f $line, [DateTime]::UtcNow.Ticks) -Encoding ASCII
    }
}

function New-WinFormsWindow {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = $Titles.WinForms
    $form.Width = 560
    $form.Height = 420
    $form.StartPosition = 'CenterScreen'

    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Name = 'FixtureTextBox'
    $tb.AccessibleName = 'Fixture Text'
    $tb.Text = 'fixture-value-42'
    $tb.Left = 24; $tb.Top = 24; $tb.Width = 300
    $form.Controls.Add($tb)

    $save = New-Object System.Windows.Forms.Button
    $save.Name = 'SaveButton'
    $save.Text = 'Save'
    $save.Left = 24; $save.Top = 66; $save.Width = 100
    $save.Add_Click({ Add-LogLine $LogFile 'save-clicked' })
    $form.Controls.Add($save)

    $cb = New-Object System.Windows.Forms.CheckBox
    $cb.Name = 'EnableSyncCheckBox'
    $cb.Text = 'Enable sync'
    $cb.Left = 24; $cb.Top = 108; $cb.Width = 200
    $form.Controls.Add($cb)

    $list = New-Object System.Windows.Forms.ListBox
    $list.Name = 'FixtureListBox'
    $list.Left = 24; $list.Top = 144; $list.Width = 220; $list.Height = 110
    foreach ($item in @('Item One', 'Item Two', 'Item Three', 'Item Four', 'Item Five')) {
        [void]$list.Items.Add($item)
    }
    $form.Controls.Add($list)

    # Lets the harness remove a control on demand, so "element gone" is measured, not simulated.
    $remove = New-Object System.Windows.Forms.Button
    $remove.Name = 'RemoveTargetButton'
    $remove.Text = 'Remove Target'
    $remove.Left = 280; $remove.Top = 66; $remove.Width = 140
    $remove.Add_Click({
        $target = $form.Controls['EnableSyncCheckBox']
        if ($null -ne $target) {
            $form.Controls.Remove($target)
            $target.Dispose()
        }
        Add-LogLine $LogFile 'target-removed'
    })
    $form.Controls.Add($remove)

    return $form
}

function New-WpfWindow {
    $xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="ui-probe fixture (WPF)" Width="560" Height="420"
        WindowStartupLocation="CenterScreen">
  <Grid Margin="24">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>
    <TextBox x:Name="FixtureTextBox" AutomationProperties.Name="Fixture Text"
             Text="fixture-value-42" Width="300" HorizontalAlignment="Left"/>
    <Button x:Name="SaveButton" Content="Save" Width="100" Grid.Row="1"
            HorizontalAlignment="Left" Margin="0,12,0,0"/>
    <CheckBox x:Name="EnableSyncCheckBox" Content="Enable sync" Grid.Row="2"
              HorizontalAlignment="Left" Margin="0,12,0,0"/>
    <ListBox x:Name="FixtureListBox" Grid.Row="3" Width="220" Height="120"
             HorizontalAlignment="Left" Margin="0,12,0,0">
      <ListBoxItem>Item One</ListBoxItem>
      <ListBoxItem>Item Two</ListBoxItem>
      <ListBoxItem>Item Three</ListBoxItem>
      <ListBoxItem>Item Four</ListBoxItem>
      <ListBoxItem>Item Five</ListBoxItem>
    </ListBox>
  </Grid>
</Window>
'@
    $window = [System.Windows.Markup.XamlReader]::Parse($xaml)
    $window.FindName('SaveButton').Add_Click({ Add-LogLine $LogFile 'save-clicked' })
    return $window
}

function New-OwnerDrawnWindow {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = $Titles.OwnerDrawn
    $form.Width = 560
    $form.Height = 420
    $form.StartPosition = 'CenterScreen'
    $form.BackColor = [System.Drawing.Color]::White

    $panel = New-Object System.Windows.Forms.Panel
    $panel.Name = 'PaintPanel'
    $panel.Dock = 'Fill'
    $panel.BackColor = [System.Drawing.Color]::FromArgb(245, 245, 245)
    # Script scope: the Paint handler runs outside this function's scope, where a plain
    # local would be unset (that threw once per paint and left the window blank).
    $script:ownerLabels = @(
        @{ Text = 'Alpha 17'; X = 60; Y = 70 },
        @{ Text = 'Bravo 42'; X = 60; Y = 160 },
        @{ Text = 'Charlie 99'; X = 60; Y = 250 }
    )
    $script:ownerFont = New-Object System.Drawing.Font('Segoe UI', 28, [System.Drawing.FontStyle]::Bold)
    $panel.Add_Paint({
        param($sender, $e)
        $g = $e.Graphics
        $g.Clear($sender.BackColor)
        foreach ($label in $script:ownerLabels) {
            [System.Windows.Forms.TextRenderer]::DrawText($g, $label.Text, $script:ownerFont,
                (New-Object System.Drawing.Point($label.X, $label.Y)),
                [System.Drawing.Color]::Black)
        }
    })
    $form.Controls.Add($panel)
    return $form
}

if ($Kind -eq 'All') {
    $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $started = @()
    foreach ($k in @('WinForms', 'Wpf', 'OwnerDrawn')) {
        $ready = Join-Path $env:TEMP ("ui-probe-fixture-{0}.ready" -f $k)
        Remove-Item -LiteralPath $ready -ErrorAction SilentlyContinue
        $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Kind', $k, '-ReadyFile', $ready)
        if ($LogFile) { $childArgs += @('-LogFile', $LogFile) }
        $proc = Start-Process -FilePath $exe -ArgumentList $childArgs -PassThru
        $deadline = (Get-Date).AddSeconds(20)
        while (-not (Test-Path -LiteralPath $ready) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 100
        }
        if (-not (Test-Path -LiteralPath $ready)) {
            Write-Output "FAILED $k (process $($proc.Id) did not report ready)"
            continue
        }
        Write-Output ("READY {0} PID {1}" -f $k, $proc.Id)
        $started += $proc.Id
    }
    Write-Output ("ALL " + ($started -join ' '))
    exit 0
}

switch ($Kind) {
    'WinForms' {
        $form = New-WinFormsWindow
        $form.Add_Shown({ Write-Ready $ReadyFile $PID })
        [void]$form.ShowDialog()
    }
    'Wpf' {
        $window = New-WpfWindow
        $window.Add_Loaded({ Write-Ready $ReadyFile $PID })
        $app = New-Object System.Windows.Application
        $app.Run($window) | Out-Null
    }
    'OwnerDrawn' {
        $form = New-OwnerDrawnWindow
        $form.Add_Shown({ Write-Ready $ReadyFile $PID })
        [void]$form.ShowDialog()
    }
}
